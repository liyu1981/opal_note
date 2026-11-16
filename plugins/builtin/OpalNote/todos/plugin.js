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

  const items = rows.map(function (row) {
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
  });

  return JSON.stringify({
    items: items,
    ui: {
      schema: 1,
      root: {
        type: "card",
        title: "Open todos",
        children: [
          {
            type: "list",
            emptyText: "All clear.",
            items: items.map(function (item) {
              return {
                title: item.title,
                detail: item.detail,
                note_path: item.note_path,
                status: item.status,
                action: { type: "openNote", path: item.note_path }
              };
            })
          }
        ]
      }
    }
  });
})()
