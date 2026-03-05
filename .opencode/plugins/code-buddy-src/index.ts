/**
 * Code Buddy Plugin — entry point.
 *
 * Wires together storage, config, state, tools, and hooks.
 */

import type { Plugin } from "@opencode-ai/plugin";
import * as path from "node:path";
import * as os from "node:os";
import { LocalStorage } from "./storage";
import { loadConfig } from "./config";
import { PluginState } from "./state";
import { getLLMStatus, testLLMConnection } from "./llm";
import { createTools } from "./tools";
import { createHooks } from "./hooks";
import { JsonStorageBackend } from "./storage-interface";
import { MarkdownStorage } from "./markdown-storage";
import type { StorageBackend } from "./storage-interface";

export const CodeBuddyPlugin: Plugin = async (ctx) => {
    const { client } = ctx;
    const globalBase = path.join(os.homedir(), ".config", "opencode", "code-buddy");
    const configPath = path.join(globalBase, "config.json");

    const config = loadConfig(configPath);
    // Create a verbose-aware log for early subsystems (before state exists)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const log = (...args: any[]) => { if (config.features.verbose !== false) console.log(...args); };
    const dataDir = path.join(globalBase, "data");
    const storage = new LocalStorage(dataDir, log);

    // Create the storage backend based on config
    let backend: StorageBackend;
    if (config.storage.format === "markdown") {
        backend = new MarkdownStorage(dataDir, log);
        log("[code-buddy] Using markdown storage backend");
    } else {
        backend = new JsonStorageBackend(storage);
        log("[code-buddy] Using JSON storage backend");
    }

    const state = new PluginState(storage, config, configPath, client, backend);

    // When disabled, only expose buddy_config so the user can re-enable
    if (config.enabled === false) {
        log("[code-buddy] Plugin disabled. Use buddy_config(\"set_enabled\", \"true\") to re-enable.");
        const allTools = createTools(state);
        return { tool: { buddy_config: allTools.buddy_config } };
    }

    // Non-blocking startup: log status then test LLM connectivity
    getLLMStatus(state).then((status) =>
        state.log(`[code-buddy] Plugin initialized - LLM: ${status}`),
    );
    testLLMConnection(state).catch(() => { /* logged internally */ });

    return {
        tool: createTools(state),
        ...createHooks(state),
    };
};

export default CodeBuddyPlugin;
