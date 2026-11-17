import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  dropCursor,
  keymap,
  placeholder,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { autocompletion, completionKeymap } from "@codemirror/autocomplete";

import { api } from "../../api/client";
import { assetMarkdown, formatBytes } from "../../lib/assets";
import { useAppNavigate } from "../../lib/appNavigation";
import { safeExternalUrl } from "../../lib/markdown";
import {
  livePreview,
  refreshLivePreview,
  type LinkTarget,
  type LivePreviewOptions,
} from "../../lib/livePreview";
import { noteEditorTheme, noteMarkdownHighlighting } from "../../lib/editorTheme";
import {
  viewerByExtension,
  viewerEntryUrl,
  viewerPluginsAtom,
} from "../../plugins/viewers";
import { settingsAtom } from "../../lib/settings";
import { assetRevisionAtom, diagramLightboxAtom } from "../../state/atoms";
import { wikiLinkCompletionSource } from "../../lib/wikiCompletion";
import { slashCommandSource } from "../../lib/slashCommands";

const STARTERS: Record<string, string> = {
  mermaid: "flowchart LR\n  A[Start] --> B[End]\n",
  excalidraw: JSON.stringify(
    {
      type: "excalidraw",
      version: 2,
      source: "opalnote",
      elements: [],
      appState: {},
      files: {},
    },
    null,
    2,
  ),
};

export type LiveMarkdownEditorHandle = {
  focus: () => void;
  blur: () => void;
  focusStart: () => void;
  focusEnd: () => void;
};

type Props = {
  value: string;
  onChange: (value: string) => void;
  onWikiLink: (target: string) => void;
  onTag: (tag: string) => void;
  notebookId: string;
  notePath: string;
  linkKeys: Set<string>;
  linkTargets: LinkTarget[];
  readOnly: boolean;
  autoHeight?: boolean;
  autoFocus?: boolean;
  /** Called when the caret leaves the first/last line. Return true when a
   * sibling page took focus; false lets CodeMirror handle the key normally. */
  onNavigate?: (direction: "up" | "down") => boolean;
};

/**
 * A fixed-width, block-oriented markdown surface. Markdown syntax renders in
 * place and reveals itself on the block under the cursor; links and tasks are
 * interactive without leaving the editor.
 */
function readOnlyExtensions(readOnly: boolean): Extension[] {
  return [
    EditorState.readOnly.of(readOnly),
    EditorView.editable.of(!readOnly),
  ];
}

export const LiveMarkdownEditor = forwardRef<
  LiveMarkdownEditorHandle,
  Props
>(function LiveMarkdownEditor(
  {
    value,
    onChange,
    onWikiLink,
    onTag,
    notebookId,
    notePath,
    linkKeys,
    linkTargets,
    readOnly,
    autoHeight = false,
    autoFocus = false,
    onNavigate,
  },
  ref,
) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const readOnlyCompartment = useRef(new Compartment());
  const readOnlyRef = useRef(readOnly);
  const settings = useAtomValue(settingsAtom);
  const maxUploadBytesRef = useRef(settings.maxUploadMb * 1024 * 1024);
  maxUploadBytesRef.current = settings.maxUploadMb * 1024 * 1024;
  const navigate = useAppNavigate();
  const openAssetRef = useRef<(assetPath: string) => void>(() => {});
  openAssetRef.current = (assetPath) =>
    navigate({ view: "asset", path: assetPath });
  const viewerPlugins = useAtomValue(viewerPluginsAtom);
  const viewerMap = viewerByExtension(viewerPlugins);
  const setDiagramLightbox = useSetAtom(diagramLightboxAtom);
  const assetRevision = useAtomValue(assetRevisionAtom);
  const onOpenViewerRef = useRef<
    ((assetPath: string, extension: string) => void) | null
  >(null);
  onOpenViewerRef.current = (assetPath, extension) =>
    setDiagramLightbox({ notebookId, path: assetPath, extension });

  readOnlyRef.current = readOnly;
  const onChangeRef = useRef(onChange);
  const onWikiLinkRef = useRef(onWikiLink);
  const onTagRef = useRef(onTag);
  const onNavigateRef = useRef(onNavigate);
  const linkTargetsRef = useRef<LinkTarget[]>(linkTargets);
  const initialValueRef = useRef(value);
  const initialReadOnlyRef = useRef(readOnly);
  const autoFocusRef = useRef(autoFocus);

  onChangeRef.current = onChange;
  onWikiLinkRef.current = onWikiLink;
  onTagRef.current = onTag;
  onNavigateRef.current = onNavigate;
  linkTargetsRef.current = linkTargets;

  const optionsRef = useRef<LivePreviewOptions>({
    linkKeys,
    onWikiLink: (target) => onWikiLinkRef.current(target),
    onOpenLink: (url) => {
      const safe = safeExternalUrl(url);
      if (!safe) return;
      window.open(safe, "_blank", "noopener,noreferrer");
    },
    onTag: (tag) => onTagRef.current(tag),
    onOpenAsset: (assetPath) => openAssetRef.current(assetPath),
    viewerFor: () => null,
    onOpenViewer: (assetPath, extension) =>
      onOpenViewerRef.current?.(assetPath, extension),
    assetRevision: 0,
    readOnly,
    notePath,
    loadAsset: (path) => api.getAssetBlob(notebookId, path),
  });
  optionsRef.current = {
    ...optionsRef.current,
    linkKeys,
    readOnly,
    notePath,
    loadAsset: (path) => api.getAssetBlob(notebookId, path),
    onOpenAsset: (assetPath) => openAssetRef.current(assetPath),
    viewerFor: (extension) => {
      const plugin = viewerMap.get(extension);
      return plugin ? { id: plugin.id, src: viewerEntryUrl(plugin) } : null;
    },
    onOpenViewer: (assetPath, extension) => {
      onOpenViewerRef.current?.(assetPath, extension);
    },
    assetRevision,
  };

  /** Create a viewer asset from a starter template and embed it. */
  function createViewerAsset(
    view: EditorView,
    from: number,
    to: number,
    extension: string,
  ) {
    if (readOnlyRef.current) return;
    view.dispatch({
      changes: { from, to, insert: "" },
      selection: { anchor: from },
    });
    const title = notePath.split("/").pop()?.replace(/\.md$/u, "") ?? "Diagram";
    void api
      .createAssetContent(notebookId, {
        name: title,
        extension,
        content: STARTERS[extension] ?? "",
        folder: "diagrams",
      })
      .then((asset) => {
        const editorView = viewRef.current;
        if (!editorView) return;
        const markdown = assetMarkdown(asset);
        const at = Math.min(from, editorView.state.doc.length);
        editorView.dispatch({
          changes: { from: at, insert: markdown },
          selection: { anchor: at + markdown.length },
          scrollIntoView: true,
        });
        editorView.focus();
        setDiagramLightbox({ notebookId, path: asset.path, extension });
      })
      .catch((cause) => {
        window.alert(
          cause instanceof Error
            ? cause.message
            : "Could not create the diagram",
        );
      });
  }

  /** Upload a file chosen from the `/upload` command and insert its markdown. */
  function insertUploadedAsset(file: File, from: number) {
    const limit = maxUploadBytesRef.current;
    if (file.size > limit) {
      window.alert(
        `“${file.name}” is ${formatBytes(file.size)}, larger than the ${formatBytes(limit)} upload limit (Settings → Files).`,
      );
      return;
    }
    void api
      .uploadAsset(notebookId, file)
      .then((asset) => {
        const view = viewRef.current;
        if (!view) return;
        const markdown = assetMarkdown(asset);
        const at = Math.min(from, view.state.doc.length);
        view.dispatch({
          changes: { from: at, insert: markdown },
          selection: { anchor: at + markdown.length },
          scrollIntoView: true,
        });
        view.focus();
      })
      .catch((cause) => {
        window.alert(
          cause instanceof Error ? cause.message : "Could not upload the file",
        );
      });
  }

  function requestUpload(view: EditorView, from: number, to: number) {
    if (readOnlyRef.current) return;
    // Drop the `/upload` text first; the markdown lands where it was typed once
    // the server has stored the file.
    view.dispatch({
      changes: { from, to, insert: "" },
      selection: { anchor: from },
    });
    const input = document.createElement("input");
    input.type = "file";
    input.accept = [
      "image/*",
      "audio/*",
      "video/*",
      ".pdf",
      ".doc",
      ".docx",
      ".xls",
      ".xlsx",
      ".ppt",
      ".pptx",
      ".odt",
      ".ods",
      ".odp",
      ".rtf",
      ".txt",
      ".md",
      ".csv",
      ".json",
      ".yaml",
      ".yml",
      ".xml",
      ".epub",
      ".zip",
      ".tar",
      ".gz",
      ".tgz",
      ".7z",
      ".rar",
    ].join(",");
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (file) insertUploadedAsset(file, from);
    });
    input.click();
  }

  useImperativeHandle(
    ref,
    () => ({
      focus: () => viewRef.current?.focus(),
      blur: () => viewRef.current?.contentDOM.blur(),
      focusStart: () => focusAt("start"),
      focusEnd: () => focusAt("end"),
    }),
    [],
  );

  function focusAt(edge: "start" | "end") {
    const view = viewRef.current;
    if (!view) return;
    const position = edge === "start" ? 0 : view.state.doc.length;
    view.focus();
    view.dispatch({
      selection: { anchor: position },
      scrollIntoView: true,
    });
    view.dom.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  function atDocumentEdge(
    view: EditorView,
    direction: "up" | "down",
  ): boolean {
    if (!onNavigateRef.current) return false;
    const selection = view.state.selection.main;
    if (!selection.empty) return false;
    const line = view.state.doc.lineAt(selection.head);
    if (direction === "up" && line.number !== 1) return false;
    if (direction === "down" && line.number !== view.state.doc.lines) return false;
    return onNavigateRef.current(direction);
  }

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const extensions: Extension[] = [
      history(),
      drawSelection(),
      dropCursor(),
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({
        "aria-label": "Note body",
        spellcheck: "true",
        autocapitalize: "off",
        autocomplete: "off",
      }),
      markdown({ addKeymap: true, codeLanguages: languages }),
      noteMarkdownHighlighting,
      autocompletion({
        override: [
          wikiLinkCompletionSource(linkTargetsRef),
          (context) =>
            slashCommandSource(context, {
              onUpload: (view, from, to) => requestUpload(view, from, to),
              onCreateViewer: (view, from, to, extension) =>
                createViewerAsset(view, from, to, extension),
            }),
        ],
        activateOnTyping: true,
        icons: false,
      }),
      keymap.of([
        ...completionKeymap,
        { key: "ArrowDown", run: (view) => atDocumentEdge(view, "down") },
        { key: "ArrowUp", run: (view) => atDocumentEdge(view, "up") },
        ...defaultKeymap,
        ...historyKeymap,
        indentWithTab,
      ]),
      readOnlyCompartment.current.of(
        readOnlyExtensions(initialReadOnlyRef.current),
      ),
      livePreview(optionsRef),
      noteEditorTheme,
      placeholder(
        "Write in markdown. Type [[ to link a note, # to tag, - for a block.",
      ),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          onChangeRef.current(update.state.doc.toString());
        }
        if (update.selectionSet && !update.docChanged) {
          // Auto-height editors do not have a scrollable CodeMirror scroller;
          // keep the active line visible in the page/card scroll container.
          window.setTimeout(() => {
            view.dom
              .querySelector<HTMLElement>(".cm-line.cm-live-active")
              ?.scrollIntoView({ block: "nearest", inline: "nearest" });
          }, 60);
        }
      }),
    ];

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: initialValueRef.current,
        extensions,
      }),
    });
    viewRef.current = view;
    if (autoFocusRef.current && !initialReadOnlyRef.current) view.focus();

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  // External resets (new note, server normalization) travel through `value`;
  // ordinary typing is already in the document and is a no-op here.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
    });
  }, [value]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: readOnlyCompartment.current.reconfigure(
        readOnlyExtensions(readOnly),
      ),
    });
    if (readOnly) view.contentDOM.blur();
    view.dispatch({ effects: refreshLivePreview.of(null) });
  }, [readOnly]);

  // Link resolution changes after saves/refreshes; rebuild the widgets without
  // touching the document or the cursor.
  useEffect(() => {
    viewRef.current?.dispatch({ effects: refreshLivePreview.of(null) });
  }, [linkKeys]);

  // A saved diagram changes bytes, not markdown: re-mount viewer widgets.
  useEffect(() => {
    viewRef.current?.dispatch({ effects: refreshLivePreview.of(null) });
  }, [assetRevision, viewerPlugins]);

  return (
    <div
      ref={hostRef}
      className={autoHeight ? "cm-auto-height w-full" : "h-full min-h-0 w-full"}
    />
  );
});
