import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
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
import { autocompletion, completionKeymap } from "@codemirror/autocomplete";

import {
  livePreview,
  refreshLivePreview,
  type LinkTarget,
  type LivePreviewOptions,
} from "../../lib/livePreview";
import { noteEditorTheme, noteMarkdownHighlighting } from "../../lib/editorTheme";
import { wikiLinkCompletionSource } from "../../lib/wikiCompletion";

export type LiveMarkdownEditorHandle = {
  focus: () => void;
};

type Props = {
  value: string;
  onChange: (value: string) => void;
  onWikiLink: (target: string) => void;
  linkKeys: Set<string>;
  linkTargets: LinkTarget[];
  live: boolean;
  autoFocus?: boolean;
};

/**
 * A fixed-width, block-oriented markdown surface. Markdown syntax renders in
 * place and reveals itself on the block under the cursor; links and tasks are
 * interactive without leaving the editor.
 */
export const LiveMarkdownEditor = forwardRef<
  LiveMarkdownEditorHandle,
  Props
>(function LiveMarkdownEditor(
  {
    value,
    onChange,
    onWikiLink,
    linkKeys,
    linkTargets,
    live,
    autoFocus = false,
  },
  ref,
) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const liveCompartment = useRef(new Compartment());

  const onChangeRef = useRef(onChange);
  const onWikiLinkRef = useRef(onWikiLink);
  const linkTargetsRef = useRef<LinkTarget[]>(linkTargets);
  const initialValueRef = useRef(value);
  const initialLiveRef = useRef(live);
  const autoFocusRef = useRef(autoFocus);

  onChangeRef.current = onChange;
  onWikiLinkRef.current = onWikiLink;
  linkTargetsRef.current = linkTargets;

  const optionsRef = useRef<LivePreviewOptions>({
    linkKeys,
    onWikiLink: (target) => onWikiLinkRef.current(target),
    onOpenLink: (url) => {
      window.open(url, "_blank", "noopener,noreferrer");
    },
  });
  optionsRef.current = { ...optionsRef.current, linkKeys };

  useImperativeHandle(
    ref,
    () => ({
      focus: () => viewRef.current?.focus(),
    }),
    [],
  );

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
      markdown({ addKeymap: true }),
      noteMarkdownHighlighting,
      autocompletion({
        override: [wikiLinkCompletionSource(linkTargetsRef)],
        activateOnTyping: true,
        icons: false,
      }),
      keymap.of([
        ...completionKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        indentWithTab,
      ]),
      liveCompartment.current.of(
        initialLiveRef.current ? livePreview(optionsRef) : [],
      ),
      noteEditorTheme,
      placeholder(
        "Write in markdown. Type [[ to link a note, # to tag, - for a block.",
      ),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          onChangeRef.current(update.state.doc.toString());
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
    if (autoFocusRef.current) view.focus();

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
    viewRef.current?.dispatch({
      effects: liveCompartment.current.reconfigure(
        live ? livePreview(optionsRef) : [],
      ),
    });
  }, [live]);

  // Link resolution changes after saves/refreshes; rebuild the widgets without
  // touching the document or the cursor.
  useEffect(() => {
    viewRef.current?.dispatch({ effects: refreshLivePreview.of(null) });
  }, [linkKeys]);

  return <div ref={hostRef} className="h-full min-h-0 w-full" />;
});
