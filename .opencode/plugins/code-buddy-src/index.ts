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
import { getLLMStatus } from "./llm";
import { createTools } from "./tools";
import { createHooks } from "./hooks";

export const CodeBuddyPlugin: Plugin = async (ctx) => {
    const { client } = ctx;
    const globalBase = path.join(os.homedir(), ".config", "opencode", "code-buddy");
    const configPath = path.join(globalBase, "config.json");

    const config = loadConfig(configPath);
    const storage = new LocalStorage(path.join(globalBase, "data"));
    const state = new PluginState(storage, config, configPath, client);

    // Log initial status (non-blocking)
    getLLMStatus(state).then((status) =>
        console.log(`[code-buddy] Plugin initialized - LLM: ${status}`),
    );

    return {
        tool: createTools(state),
        ...createHooks(state),
    };
};

export default CodeBuddyPlugin;
