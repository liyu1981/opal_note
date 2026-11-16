import { favoritesPlugin } from "./favorites";
import { recentPlugin } from "./recent";

/** Client-side plugins backed by browser-local state or app-only data. */
export const BUILTIN_CLIENT_PLUGINS = [favoritesPlugin, recentPlugin];
