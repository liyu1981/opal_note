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
