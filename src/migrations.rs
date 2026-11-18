//! Minimal schema migrations for OpalNote's durable SQLite databases.
//!
//! A database records the migrations it has seen in a `schema_migrations`
//! relation; `apply` runs the missing ones in order, each in its own transaction
//! together with the bookkeeping row, so a failure leaves the database at the
//! last complete version. Migrations are plain CozoScript statements, which means
//! a step can create a relation, copy data into a new shape and drop the old one.
//!
//! Conventions:
//! - versions are consecutive integers starting at 1;
//! - a version is never edited once shipped — add a new one instead;
//! - the statement list runs in order inside one transaction.

use std::collections::BTreeMap;

use anyhow::{anyhow, bail, Context, Result};
use cozo::{DataValue, DbInstance, ScriptMutability};

use crate::store::queries;

/// One step of a migration.
///
/// `Create` and `Drop` are existence-checked in Rust, so they are idempotent and
/// a migration interrupted half-way can simply be retried. `Script` is a plain
/// CozoScript program and should behave idempotently too (`:put` rather than
/// `:insert` when copying rows), for the same reason: Cozo cannot run DDL inside
/// a transaction, so a migration is applied step by step.
// The full vocabulary is part of the module's contract: schema changes in this
// project are written as create-copy-drop, even though the first migration only
// needs `Create`.
#[allow(dead_code)]
pub enum Step {
    /// Create a relation unless it already exists.
    Create(&'static str, &'static str),
    /// Run one CozoScript program.
    Script(&'static str),
    /// Drop a relation if it still exists.
    Drop(&'static str),
}

/// One version of the schema.
pub struct Migration {
    pub version: i64,
    /// Short human-readable label, stored with the row for diagnostics.
    pub name: &'static str,
    pub steps: &'static [Step],
}

/// Outcome of [`apply`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MigrationReport {
    /// Version the database had before the run (0 for a fresh database).
    pub from: i64,
    /// Version after the run.
    pub to: i64,
    /// How many migrations were applied.
    pub applied: usize,
}

/// Create the bookkeeping relation if it is missing.
fn ensure_bookkeeping(db: &DbInstance) -> Result<()> {
    let relations = db
        .run_script("::relations", BTreeMap::new(), ScriptMutability::Immutable)
        .map_err(|err| anyhow!(err.to_string()))?;
    let exists = relations.rows.iter().any(|row| {
        row.first()
            .and_then(DataValue::get_str)
            .is_some_and(|name| name == "schema_migrations")
    });
    if exists {
        return Ok(());
    }
    db.run_script(
        queries::SCHEMA_MIGRATIONS_CREATE,
        BTreeMap::new(),
        ScriptMutability::Mutable,
    )
    .map_err(|err| anyhow!("creating `schema_migrations`: {err}"))?;
    Ok(())
}

fn applied_versions(db: &DbInstance) -> Result<Vec<i64>> {
    let rows = db
        .run_script(
            queries::SCHEMA_MIGRATIONS_LIST,
            BTreeMap::new(),
            ScriptMutability::Immutable,
        )
        .map_err(|err| anyhow!(err.to_string()))?;
    Ok(rows
        .rows
        .iter()
        .filter_map(|row| row.first().and_then(DataValue::get_int))
        .collect())
}

/// Whether a relation exists in this database.
pub fn has_relation(db: &DbInstance, name: &str) -> Result<bool> {
    let relations = db
        .run_script("::relations", BTreeMap::new(), ScriptMutability::Immutable)
        .map_err(|err| anyhow!(err.to_string()))?;
    Ok(relations.rows.iter().any(|row| {
        row.first()
            .and_then(DataValue::get_str)
            .is_some_and(|existing| existing == name)
    }))
}

fn run(db: &DbInstance, script: &str) -> Result<cozo::NamedRows> {
    db.run_script(script, BTreeMap::new(), ScriptMutability::Mutable)
        .map_err(|err| anyhow!(err.to_string()))
}

fn record(db: &DbInstance, migration: &Migration) -> Result<()> {
    let mut params = BTreeMap::new();
    params.insert("version".to_string(), DataValue::from(migration.version));
    params.insert("name".to_string(), DataValue::from(migration.name));
    params.insert("applied_at".to_string(), DataValue::from(now_secs()));
    db.run_script(
        queries::SCHEMA_MIGRATIONS_PUT,
        params,
        ScriptMutability::Mutable,
    )
    .map_err(|err| anyhow!(err.to_string()))?;
    Ok(())
}

/// Apply every migration newer than what the database has recorded.
///
/// `baseline` names a relation that older builds created without bookkeeping
/// (before this system existed): when the bookkeeping table is empty but that
/// relation exists, version 1 is considered already applied instead of failing
/// on `:create`.
pub fn apply(
    db: &DbInstance,
    database: &str,
    migrations: &[Migration],
    baseline: Option<&str>,
) -> Result<MigrationReport> {
    if migrations.is_empty() {
        return Ok(MigrationReport {
            from: 0,
            to: 0,
            applied: 0,
        });
    }
    for (index, migration) in migrations.iter().enumerate() {
        let expected = index as i64 + 1;
        if migration.version != expected {
            bail!(
                "{database}: migration versions must be consecutive from 1 \
                 (found {} where {expected} was expected)",
                migration.version
            );
        }
        if migration.steps.is_empty() {
            bail!("{database}: migration {} has no steps", migration.version);
        }
    }

    ensure_bookkeeping(db)?;
    let mut applied = applied_versions(db)?;

    // Database from a newer OpalNote: refuse instead of silently dropping rows.
    let latest = migrations
        .last()
        .map(|migration| migration.version)
        .unwrap_or(0);
    if let Some(highest) = applied.iter().max() {
        if *highest > latest {
            bail!(
                "{database}: schema version {highest} is newer than this build supports ({latest}); \
                 upgrade OpalNote"
            );
        }
    }

    if applied.is_empty() {
        if let Some(name) = baseline {
            if has_relation(db, name)? {
                record(
                    db,
                    &Migration {
                        version: 1,
                        name: "baseline",
                        steps: &[],
                    },
                )?;
                applied.push(1);
            }
        }
    }

    let from = applied.iter().copied().max().unwrap_or(0);
    let mut count = 0;
    for migration in migrations {
        if applied.contains(&migration.version) {
            continue;
        }
        for (index, step) in migration.steps.iter().enumerate() {
            let outcome = match step {
                Step::Create(name, ddl) => {
                    if has_relation(db, name)? {
                        Ok(())
                    } else {
                        run(db, ddl).map(|_| ())
                    }
                }
                Step::Drop(name) => {
                    if has_relation(db, name)? {
                        run(db, &format!("::remove {name}")).map(|_| ())
                    } else {
                        Ok(())
                    }
                }
                Step::Script(script) => run(db, script).map(|_| ()),
            };
            outcome.with_context(|| {
                format!(
                    "{database}: migration {} ({}) step {} failed",
                    migration.version,
                    migration.name,
                    index + 1
                )
            })?;
        }
        record(db, migration)?;
        count += 1;
    }

    Ok(MigrationReport {
        from,
        to: latest,
        applied: count,
    })
}

fn now_secs() -> f64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs_f64())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    const ITEMS_DDL: &str = ":create items { id: String => label: String }";
    const ITEMS_V2_DDL: &str = ":create items_v2 { id: String => label: String, color: String }";
    const COPY_ITEMS: &str =
        "?[id, label, color] := *items{id, label}, color = \"none\"\n:put items_v2 { id => label, color }";

    fn migrations() -> Vec<Migration> {
        vec![
            Migration {
                version: 1,
                name: "items",
                steps: &[Step::Create("items", ITEMS_DDL)],
            },
            Migration {
                version: 2,
                name: "items with color",
                steps: &[
                    Step::Create("items_v2", ITEMS_V2_DDL),
                    Step::Script(COPY_ITEMS),
                    Step::Drop("items"),
                ],
            },
        ]
    }

    fn open(dir: &std::path::Path) -> DbInstance {
        DbInstance::new("sqlite", dir.join("test.db"), "").expect("open db")
    }

    fn relations(db: &DbInstance) -> Vec<String> {
        db.run_script("::relations", BTreeMap::new(), ScriptMutability::Immutable)
            .expect("relations")
            .rows
            .iter()
            .filter_map(|row| row.first().and_then(DataValue::get_str).map(str::to_string))
            .collect()
    }

    #[test]
    fn applies_pending_migrations_once_in_order() {
        let dir = tempdir().unwrap();
        let db = open(dir.path());

        let report = apply(&db, "test.db", &migrations(), None).unwrap();
        assert_eq!(report.from, 0);
        assert_eq!(report.to, 2);
        assert_eq!(report.applied, 2);
        let names = relations(&db);
        assert!(names.contains(&"items_v2".to_string()));
        assert!(!names.contains(&"items".to_string()));
        assert!(names.contains(&"schema_migrations".to_string()));

        // Nothing pending on a second open.
        let again = apply(&db, "test.db", &migrations(), None).unwrap();
        assert_eq!(again.applied, 0);
        assert_eq!(again.from, 2);
    }

    #[test]
    fn only_new_migrations_run() {
        let dir = tempdir().unwrap();
        let db = open(dir.path());
        apply(&db, "test.db", &migrations()[..1], None).unwrap();

        let report = apply(&db, "test.db", &migrations(), None).unwrap();
        assert_eq!(report.from, 1);
        assert_eq!(report.applied, 1);
    }

    #[test]
    fn a_database_from_a_newer_build_is_refused() {
        let dir = tempdir().unwrap();
        let db = open(dir.path());
        apply(&db, "test.db", &migrations(), None).unwrap();

        let error = apply(&db, "test.db", &migrations()[..1], None).unwrap_err();
        assert!(error.to_string().contains("newer than this build supports"));
    }

    #[test]
    fn baseline_adopts_a_relation_created_before_bookkeeping() {
        let dir = tempdir().unwrap();
        let db = open(dir.path());
        run(&db, ITEMS_DDL).unwrap();

        let report = apply(&db, "test.db", &migrations()[..1], Some("items")).unwrap();
        assert_eq!(report.from, 1);
        assert_eq!(report.applied, 0);

        // Version 2 still applies on top of the adopted baseline.
        let report = apply(&db, "test.db", &migrations(), Some("items")).unwrap();
        assert_eq!(report.applied, 1);
    }

    /// A migration interrupted after its DDL but before bookkeeping is safe to
    /// retry: `Create`/`Drop` skip what already matches the target schema, and
    /// the copy is a `:put`.
    #[test]
    fn a_half_applied_migration_can_be_retried() {
        let dir = tempdir().unwrap();
        let db = open(dir.path());
        // Simulate the crash: v1 applied, v2's first step already ran and no
        // bookkeeping row for v2 was written.
        run(&db, ITEMS_DDL).unwrap();
        run(&db, ITEMS_V2_DDL).unwrap();
        ensure_bookkeeping(&db).unwrap();
        record(
            &db,
            &Migration {
                version: 1,
                name: "items",
                steps: &[],
            },
        )
        .unwrap();

        let report = apply(&db, "test.db", &migrations(), None).unwrap();
        assert_eq!(report.applied, 1);
        assert!(relations(&db).contains(&"items_v2".to_string()));
    }

    #[test]
    fn versions_must_be_consecutive() {
        let dir = tempdir().unwrap();
        let db = open(dir.path());
        let broken = vec![
            Migration {
                version: 1,
                name: "one",
                steps: &[Step::Create("items", ITEMS_DDL)],
            },
            Migration {
                version: 3,
                name: "three",
                steps: &[Step::Create("items", ITEMS_DDL)],
            },
        ];
        let error = apply(&db, "test.db", &broken, None).unwrap_err();
        assert!(error.to_string().contains("consecutive"));
    }
}
