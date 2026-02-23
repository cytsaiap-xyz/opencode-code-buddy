/**
 * Plugin configuration: defaults, loading, saving.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { PluginConfig } from "./types";

export const defaultConfig: PluginConfig = {
    llm: {
        preferredProvider: "",
        preferredModel: "",
        maxTokens: 2048,
        temperature: 0.7,
    },
    storage: {
        dataDir: ".opencode/code-buddy/data",
    },
    features: {
        memory: true,
        knowledgeGraph: true,
        errorLearning: true,
        workflow: true,
        ai: true,
        verbose: true,
    },
    hooks: {
        autoRemind: true,
        protectEnv: true,
        trackFiles: false,
        compactionContext: true,
        autoObserve: true,
        observeMinActions: 3,
        observeIgnoreTools: [
            "buddy_remember", "buddy_help", "buddy_remember_recent",
            "buddy_remember_stats", "buddy_remember_by_category",
        ],
        fullAuto: true,
        autoErrorDetect: true,
    },
};

/** Deep-merge loaded config with defaults so partial configs don't lose fields. */
function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
    const result = { ...target };
    for (const key of Object.keys(source)) {
        if (
            source[key] && typeof source[key] === "object" && !Array.isArray(source[key])
            && target[key] && typeof target[key] === "object" && !Array.isArray(target[key])
        ) {
            result[key] = deepMerge(target[key] as Record<string, unknown>, source[key] as Record<string, unknown>);
        } else {
            result[key] = source[key];
        }
    }
    return result;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LogFn = (...args: any[]) => void;

export function loadConfig(configPath: string, log: LogFn = console.log): PluginConfig {
    try {
        if (fs.existsSync(configPath)) {
            const loaded = JSON.parse(fs.readFileSync(configPath, "utf-8"));
            const merged = deepMerge(defaultConfig as unknown as Record<string, unknown>, loaded) as unknown as PluginConfig;
            log("[code-buddy] Config loaded from", configPath);
            return merged;
        }
        // Create default config
        const dir = path.dirname(configPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 4), "utf-8");
        log("[code-buddy] Default config created at", configPath);
    } catch (error) {
        log("[code-buddy] Error loading config:", error);
    }
    return { ...defaultConfig };
}

export function saveConfig(configPath: string, config: PluginConfig): void {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 4), "utf-8");
}
