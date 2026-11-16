# Plugin UI Expansion Research

This document evaluates whether OpalNote journal plugins should be able to
supply their own UI fragments, and records the security and architecture
trade-offs.

## Current state

Plugins are server-side data providers:

```text
plugin.js -> QuickJS -> JSON { items: [...] }
```

The client currently has a fixed renderer:

```text
HomeView fetches plugin results
  -> selects OpalNote/todos
  -> PluginCard renders a todo-specific layout
```

The server executes all registered plugins, but the client ignores every result
except the built-in todos plugin.

This works, but it couples the UI to one plugin id and one item schema.

## The central question

The right design depends on the plugin trust model:

> Are data plugins trusted code supplied by the user, or untrusted third-party
> code?

The existing QuickJS runner assumes untrusted server code. If a plugin can run
arbitrary JavaScript in the main browser origin, that assumption disappears.

## Feasible approaches

### A. Renderer registry with fixed UI kinds

The plugin returns a renderer kind plus data:

```json
{
  "items": [],
  "ui": {
    "kind": "todo-list",
    "title": "Open todos"
  }
}
```

The client has an allowlist of renderers:

```text
todo-list -> TodoPluginCard
link-list -> LinkListPluginCard
timeline  -> TimelinePluginCard
stat-grid -> StatGridPluginCard
```

**Pros**

- Lowest security risk
- No client-side plugin JavaScript
- Keeps the QuickJS sandbox
- Consistent theme and layout
- Easy validation and testing
- Backward compatible via a fallback renderer
- Can ship incrementally

**Cons**

- Only renderers implemented by the client are available
- Every new view kind still needs frontend work
- Not truly arbitrary UI fragments

### B. Declarative UI schema

The plugin returns a JSON UI tree:

```json
{
  "ui": {
    "schema": 1,
    "root": {
      "type": "card",
      "title": "Recent links",
      "children": [
        {
          "type": "list",
          "items": [
            {
              "title": "Example",
              "action": { "type": "openNote", "path": "pages/example.md" }
            }
          ]
        }
      ]
    }
  }
}
```

The client maps a closed set of node types to React components:

```text
card, section, heading, text, badge, list, button, link,
row, separator, empty
```

Actions are also declarative:

```text
openNote, openTag, openExternal, runCommand
```

**Pros**

- More expressive than fixed kinds
- No arbitrary browser code
- Stays theme-aware, responsive and keyboard-friendly
- Action surface is auditable
- Server and client can validate depth, node count, strings, URLs
- Works with the current CSP and session model
- Versionable with a schema number

**Cons**

- Requires designing and maintaining a small UI language
- Every visual primitive must be implemented centrally
- Complex layouts become awkward
- Schema evolution and backward compatibility
- Plugin authors must learn the schema
- Accessibility and layout quality depend on the renderer

### C. HTML fragments

The server returns an HTML string which the client injects into the page.

**Pros**

- Flexible for simple widgets
- No client-side JavaScript required
- Familiar to plugin authors

**Cons**

- XSS risk
- Sanitization is mandatory and error-prone
- Event handlers cannot be serialized reliably
- CSS can leak into the app
- CSP and sanitizer interactions
- Poor React state, focus and keyboard integration
- Link/image URL validation
- Accessibility is difficult to guarantee

This should be avoided for untrusted data plugins. A heavily sanitized subset is
possible but usually less useful than a declarative schema.

### D. Client-side JavaScript or React modules

A plugin ships a browser bundle or React component which the app loads.

**Pros**

- Maximum UI flexibility
- Natural React development model
- Custom layouts, charts and interactions
- No central renderer bottleneck

**Cons**

- Breaks the current sandbox model completely
- Same-origin code can access the DOM, app globals, localStorage, IndexedDB
  and any non-HttpOnly state
- It can make authenticated same-origin API calls
- It can exfiltrate note content or user data
- Requires weakening CSP or adding a plugin script origin
- React/Tailwind duplication and bundle growth
- Asset serving, cache invalidation and versioning
- One plugin can crash or destabilize the whole app
- Code review, signing and supply-chain concerns

This is technically possible, but it is a **trusted extension model**, not a safe
plugin model. It should not be the default for arbitrary `<data-dir>/plugins`.

### E. Sandboxed iframe

A plugin supplies its own HTML/JS/CSS and runs in an iframe with a separate
origin and restricted sandbox.

**Pros**

- Real isolation boundary
- Arbitrary HTML/JS/CSS possible
- Any frontend framework
- Its own CSP possible
- Good escape hatch for trusted advanced plugins

**Cons**

- Requires a separate origin or plugin host
- Authentication and cookies become difficult
  - The current session cookie is `SameSite=Strict`
  - Cross-origin iframes need a different handshake
- postMessage protocol and origin validation
- Layout, resizing, focus, keyboard and accessibility
- Theme/font injection
- Asset hosting and versioning
- Action bridge for navigation and commands
- Debugging and testing complexity
- `frame-src` CSP changes
- Performance and lifecycle management

This is the right approach only if genuinely arbitrary custom UI is required.
It is a much larger project than a UI schema.

## Main blockers

1. **Trust model** — untrusted data plugins versus trusted local extensions.
2. **Action protocol** — open note/tag/URL/command versus plugin-defined
   mutations.
3. **CSP/session isolation** — arbitrary same-origin JS conflicts with the
   current strict CSP and HttpOnly session model.
4. **Mutation capabilities** — current plugins are read-only Datalog; forms or
   writes need a new action API and permission model.
5. **Validation** — depth, node count, strings, URLs, actions and payload size.
6. **Failure isolation** — one bad plugin must not break the workspace.
7. **Versioning** — the UI schema becomes a public API.
8. **Performance** — lazy assets, renderer cost and plugin execution latency.
9. **React integration** — focus, theme, routing, Suspense and error boundaries.
10. **Accessibility** — central renderer must preserve keyboard and screen
    reader behavior.

## Recommended phases

### Phase 1: Generic plugin results and renderer registry

- Stop hard-coding `OpalNote/todos` in Home.
- Extend the result envelope with an optional UI descriptor.
- Add a small renderer registry keyed by a safe `ui.kind`.
- Add per-plugin error boundaries and fallback cards.
- Keep plugin execution server-side and sandboxed.

This provides immediate flexibility without opening a browser-code security
hole.

### Phase 2: Declarative UI schema

Add an allowlisted node/action schema:

```text
card, section, heading, text, badge, list, button, link,
row, separator, empty
```

Actions:

```text
openNote, openTag, openExternal, runCommand
```

Validate on both server and client. Keep all plugin JavaScript in QuickJS.

### Phase 3: Optional isolated iframe host

Only if arbitrary custom UI becomes a requirement:

- separate origin
- strict iframe sandbox
- origin-checked postMessage
- explicit action bridge
- separate authentication story
- opt-in trusted plugin type

Do not make arbitrary same-origin client JavaScript the default extension model.

## Conclusion

UI fragments are feasible.

The recommended path is:

1. generic renderer registry
2. declarative JSON UI schema
3. optionally sandboxed iframes for advanced UI

Raw HTML should be avoided or heavily sanitized. Arbitrary same-origin
JavaScript breaks the current security model. The hardest work is not rendering
the fragment; it is defining trust, actions, validation and versioning.
