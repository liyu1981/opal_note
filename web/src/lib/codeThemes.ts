export type CodeTheme = {
  id: string;
  label: string;
  background: string;
  foreground: string;
  border: string;
  comment: string;
  keyword: string;
  string: string;
  number: string;
  function: string;
  type: string;
  property: string;
  operator: string;
  tag: string;
  meta: string;
  invalid: string;
};

export const CODE_THEMES: CodeTheme[] = [
  {
    id: "github-light",
    label: "GitHub Light",
    background: "#f6f8fa",
    foreground: "#24292f",
    border: "#d0d7de",
    comment: "#6e7781",
    keyword: "#cf222e",
    string: "#0a3069",
    number: "#0550ae",
    function: "#8250df",
    type: "#953800",
    property: "#116329",
    operator: "#24292f",
    tag: "#116329",
    meta: "#6e7781",
    invalid: "#82071e",
  },
  {
    id: "github-dark",
    label: "GitHub Dark",
    background: "#0d1117",
    foreground: "#c9d1d9",
    border: "#30363d",
    comment: "#8b949e",
    keyword: "#ff7b72",
    string: "#a5d6ff",
    number: "#79c0ff",
    function: "#d2a8ff",
    type: "#ffa657",
    property: "#7ee787",
    operator: "#c9d1d9",
    tag: "#7ee787",
    meta: "#8b949e",
    invalid: "#ffa198",
  },
  {
    id: "solarized-light",
    label: "Solarized Light",
    background: "#fdf6e3",
    foreground: "#657b83",
    border: "#eee8d5",
    comment: "#93a1a1",
    keyword: "#859900",
    string: "#2aa198",
    number: "#d33682",
    function: "#268bd2",
    type: "#b58900",
    property: "#268bd2",
    operator: "#657b83",
    tag: "#268bd2",
    meta: "#93a1a1",
    invalid: "#dc322f",
  },
  {
    id: "monokai",
    label: "Monokai",
    background: "#272822",
    foreground: "#f8f8f2",
    border: "#49483e",
    comment: "#75715e",
    keyword: "#f92672",
    string: "#e6db74",
    number: "#ae81ff",
    function: "#a6e22e",
    type: "#66d9ef",
    property: "#f8f8f2",
    operator: "#f92672",
    tag: "#f92672",
    meta: "#75715e",
    invalid: "#f92672",
  },
];

export const DEFAULT_CODE_THEME = "github-light";

export function getCodeTheme(id: string): CodeTheme {
  return (
    CODE_THEMES.find((theme) => theme.id === id) ??
    CODE_THEMES.find((theme) => theme.id === DEFAULT_CODE_THEME)!
  );
}
