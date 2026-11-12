//! Small, sandboxed JavaScript plugins for journal widgets.
//!
//! Each run gets a fresh QuickJS runtime and may call the read-only Datalog
//! query host. There is no filesystem/network host API. The runtime is dropped
//! after one execution; a deadline interrupts JS and bounds each query.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context as _, Result};
use cozo::{DataValue, JsonData};
use rquickjs::{Context, Ctx, Function, Runtime};
use serde::Serialize;
use serde_json::{json, Value};

use crate::store::Store;

const MAX_SCRIPT_BYTES: usize = 20_000;
const MAX_PARAMS: usize = 100;
const MAX_ITEMS: usize = 200;
const MEMORY_LIMIT_BYTES: usize = 16 * 1024 * 1024;
const STACK_LIMIT_BYTES: usize = 512 * 1024;

/// One journal plugin. Add a new entry here (and a JS source) to make another
/// widget available in the journal rail.
struct PluginDefinition {
    id: &'static str,
    title: &'static str,
    description: &'static str,
    source: &'static str,
}

const TODO_SOURCE: &str = r#"
(function () {
  const cleanTask = function (value) {
    return String(value)
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
      .replace(/\[\[([^\]]+)\]\]/g, "$1")
      .replace(/[`*]/g, "")
      .replace(/^[#>\-*+\s]+/, "")
      .trim();
  };

  const rows = __query(`
?[note_path, line, text, status, updated_at, title] :=
    *task{notebook_id, note_path, line, text, status, updated_at},
    *note{notebook_id, path: note_path, title},
    notebook_id = $notebook_id,
    status != "done",
    status != "cancelled"
:order -updated_at
:limit 100
`, { notebook_id: __notebook_id });

  return JSON.stringify({
    items: rows.map(function (row) {
      const [note_path, line, text, status, updated_at, title] = row;
      return {
        id: String(note_path) + ":" + String(line),
        title: cleanTask(text),
        detail: String(title),
        note_path: String(note_path),
        line: Number(line),
        status: String(status),
        updated_at: Number(updated_at)
      };
    })
  });
})()
"#;

const PLUGINS: &[PluginDefinition] = &[PluginDefinition {
    id: "todos",
    title: "Open todos",
    description: "Tasks not marked done or cancelled across this notebook.",
    source: TODO_SOURCE,
}];

#[derive(Debug, Clone, Serialize)]
pub struct JournalPluginResult {
    pub id: &'static str,
    pub title: &'static str,
    pub description: &'static str,
    pub items: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Run every registered plugin once for a notebook.
pub fn run_journal_plugins(
    store: &Arc<Store>,
    notebook_id: &str,
    timeout_secs: f64,
) -> Vec<JournalPluginResult> {
    let timeout = timeout_secs.clamp(0.1, 30.0);
    PLUGINS
        .iter()
        .map(
            |plugin| match run_plugin(store.clone(), notebook_id, plugin, timeout) {
                Ok(items) => JournalPluginResult {
                    id: plugin.id,
                    title: plugin.title,
                    description: plugin.description,
                    items,
                    error: None,
                },
                Err(err) => JournalPluginResult {
                    id: plugin.id,
                    title: plugin.title,
                    description: plugin.description,
                    items: json!([]),
                    error: Some(err.to_string()),
                },
            },
        )
        .collect()
}

fn run_plugin(
    store: Arc<Store>,
    notebook_id: &str,
    plugin: &PluginDefinition,
    timeout_secs: f64,
) -> Result<Value> {
    let deadline = Instant::now() + Duration::from_secs_f64(timeout_secs);
    let runtime = Runtime::new().context("creating QuickJS runtime")?;
    runtime.set_memory_limit(MEMORY_LIMIT_BYTES);
    runtime.set_max_stack_size(STACK_LIMIT_BYTES);
    runtime.set_interrupt_handler(Some(Box::new(move || Instant::now() >= deadline)));

    let context = Context::full(&runtime).context("creating QuickJS context")?;
    let output = context.with(|ctx| -> Result<String> {
        let host = host_query(ctx.clone(), store, deadline)?;
        ctx.globals()
            .set("__queryHost", host)
            .context("installing __queryHost")?;
        ctx.eval::<(), _>(
            r#"
            globalThis.__query = function (script, params) {
              const result = JSON.parse(__queryHost(script, JSON.stringify(params || {})));
              return result.rows || [];
            };
            "#,
        )
        .context("installing query bridge")?;

        let notebook = serde_json::to_string(notebook_id)?;
        let source = format!("const __notebook_id = {notebook};\n{}\n", plugin.source);
        ctx.eval::<String, _>(source)
            .with_context(|| format!("running plugin `{}`", plugin.id))
    })?;

    let value: Value = serde_json::from_str(&output)
        .with_context(|| format!("plugin `{}` returned invalid JSON", plugin.id))?;
    let items = value.get("items").cloned().unwrap_or(value);
    if !items.is_array() {
        return Err(anyhow!("plugin `{}` must return an items array", plugin.id));
    }
    let mut items = items.as_array().cloned().unwrap_or_default();
    items.truncate(MAX_ITEMS);
    Ok(Value::Array(items))
}

fn host_query<'js>(ctx: Ctx<'js>, store: Arc<Store>, deadline: Instant) -> Result<Function<'js>> {
    Function::new(
        ctx,
        move |script: String, params_json: String| -> rquickjs::Result<String> {
            let script = script.trim().to_string();
            if script.is_empty() {
                return Err(rquickjs::Error::new_from_js_message(
                    "host",
                    "query",
                    "query script must not be empty",
                ));
            }
            if script.len() > MAX_SCRIPT_BYTES {
                return Err(rquickjs::Error::new_from_js_message(
                    "host",
                    "query",
                    format!("query script must be at most {MAX_SCRIPT_BYTES} bytes"),
                ));
            }
            if script.contains("::") {
                return Err(rquickjs::Error::new_from_js_message(
                    "host",
                    "query",
                    "system commands (`::`) are not allowed in plugins",
                ));
            }

            let params = parse_params(&params_json).map_err(|err| {
                rquickjs::Error::new_from_js_message("host", "query", err.to_string())
            })?;
            let remaining = deadline
                .saturating_duration_since(Instant::now())
                .as_secs_f64();
            if remaining <= 0.0 {
                return Err(rquickjs::Error::new_from_js_message(
                    "host",
                    "query",
                    "plugin deadline exceeded",
                ));
            }

            let rows = store
                .run_query(&script, params, Some(remaining))
                .map_err(|err| {
                    rquickjs::Error::new_from_js_message("host", "query", err.to_string())
                })?;
            serde_json::to_string(&rows.into_json()).map_err(|err| {
                rquickjs::Error::new_from_js_message("host", "query", err.to_string())
            })
        },
    )
    .map_err(|err| anyhow!(err.to_string()))
}

fn parse_params(params_json: &str) -> Result<BTreeMap<String, DataValue>> {
    let value: Value = serde_json::from_str(params_json).unwrap_or(Value::Null);
    let Value::Object(object) = value else {
        return Ok(BTreeMap::new());
    };
    if object.len() > MAX_PARAMS {
        return Err(anyhow!("at most {MAX_PARAMS} query parameters are allowed"));
    }
    Ok(object
        .iter()
        .map(|(key, value)| (key.clone(), to_data_value(value)))
        .collect())
}

fn to_data_value(value: &Value) -> DataValue {
    match value {
        Value::Null => DataValue::Null,
        Value::Bool(boolean) => DataValue::Bool(*boolean),
        Value::Number(number) => {
            if let Some(int) = number.as_i64() {
                DataValue::from(int)
            } else {
                DataValue::from(number.as_f64().unwrap_or(0.0))
            }
        }
        Value::String(text) => DataValue::from(text.as_str()),
        Value::Array(items) => DataValue::List(items.iter().map(to_data_value).collect()),
        Value::Object(_) => DataValue::Json(JsonData(value.clone())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn interrupts_runaway_plugin() {
        let dir = tempdir().unwrap();
        let store = Arc::new(Store::open(dir.path(), 1.0).unwrap());
        let plugin = PluginDefinition {
            id: "runaway",
            title: "Runaway",
            description: "test",
            source: "while (true) {}",
        };
        let started = Instant::now();
        let error = run_plugin(store, "test", &plugin, 0.1).unwrap_err();
        assert!(!error.to_string().is_empty());
        assert!(started.elapsed().as_secs_f64() < 2.0);
    }
}
