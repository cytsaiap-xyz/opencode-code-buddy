/**
 * PluginState — centralised mutable state for the plugin.
 *
 * Replaces the dozens of closured variables from the old single-file design.
 * Every tool and hook receives a reference to a single PluginState instance.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
    MemoryEntry, Entity, Relation, MistakeRecord,
    SessionState, Observation, SessionBuffer, PendingDeletion, ProviderInfo, PluginConfig,
} from "./types";
import { LocalStorage } from "./storage";
import { getMemoryCategory, nowTimestamp } from "./helpers";

const MAX_LOG_BYTES = 512 * 1024; // 512 KB before rotation

export class PluginState {
    // Persisted data
    memories: MemoryEntry[];
    entities: Entity[];
    relations: Relation[];
    mistakes: MistakeRecord[];

    // Runtime-only
    session: SessionState;
    pendingDeletion: PendingDeletion | null = null;
    /** Per-session observation buffers — each agent/session gets isolated storage. */
    sessionBuffers: Map<string, SessionBuffer> = new Map();
    resolvedProvider: ProviderInfo | null = null;

    // References
    readonly storage: LocalStorage;
    readonly config: PluginConfig;
    readonly configPath: string;
    readonly client: any; // OpenCode SDK client
    private readonly logFilePath: string;

    constructor(storage: LocalStorage, config: PluginConfig, configPath: string, client: unknown) {
        this.storage = storage;
        this.config = config;
        this.configPath = configPath;
        this.client = client;
        this.logFilePath = path.join(storage.getBaseDir(), "plugin.log");

        this.memories = storage.read("memory.json", []);
        this.entities = storage.read("entities.json", []);
        this.relations = storage.read("relations.json", []);
        this.mistakes = storage.read("mistakes.json", []);

        this.session = {
            sessionId: `session_${Date.now()}`,
            startTime: Date.now(),
            lastActivity: Date.now(),
            tasksCompleted: 0,
            memoriesCreated: 0,
            errorsRecorded: 0,
            currentPhase: "idle",
        };
    }

    // ---- Persistence ----

    saveMemories(): void {
        this.storage.write("memory.json", this.memories);
    }
    saveEntities(): void {
        this.storage.write("entities.json", this.entities);
    }
    saveRelations(): void {
        this.storage.write("relations.json", this.relations);
    }
    saveMistakes(): void {
        this.storage.write("mistakes.json", this.mistakes);
    }

    // ---- Category-based queries ----

    getSolutionMemories(): MemoryEntry[] {
        return this.memories.filter((m) => getMemoryCategory(m) === "solution");
    }
    getKnowledgeMemories(): MemoryEntry[] {
        return this.memories.filter((m) => getMemoryCategory(m) === "knowledge");
    }

    // ---- Observer buffers (per-session) ----

    /** Read-only aggregate of ALL sessions' observations (for cross-session searches like guide matching). */
    get observationBuffer(): Observation[] {
        const all: Observation[] = [];
        for (const buf of this.sessionBuffers.values()) {
            all.push(...buf.observations);
        }
        return all;
    }

    pushObservation(obs: Observation): void {
        const sid = obs.sessionId || "default";
        let buf = this.sessionBuffers.get(sid);
        if (!buf) {
            buf = { observations: [] };
            this.sessionBuffers.set(sid, buf);
        }
        buf.observations.push(obs);
        if (buf.observations.length > 50) {
            buf.observations.splice(0, buf.observations.length - 50);
        }
    }

    getSessionObservations(sessionId: string): Observation[] {
        return this.sessionBuffers.get(sessionId)?.observations || [];
    }

    clearSessionObservations(sessionId: string): void {
        const buf = this.sessionBuffers.get(sessionId);
        if (buf) {
            buf.observations.length = 0;
        }
    }

    /** Clear ALL session buffers. */
    clearObservations(): void {
        this.sessionBuffers.clear();
    }

    setDelegationContext(sessionId: string, context: string): void {
        let buf = this.sessionBuffers.get(sessionId);
        if (!buf) {
            buf = { observations: [] };
            this.sessionBuffers.set(sessionId, buf);
        }
        buf.delegationContext = context;
    }

    getDelegationContext(sessionId: string): string | undefined {
        return this.sessionBuffers.get(sessionId)?.delegationContext;
    }

    // ---- Logging (respects verbose flag + persistent file) ----

    /** Format args into a single log string. Handles Error objects properly. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private formatLogArgs(args: any[]): string {
        return args.map((a) => {
            if (typeof a === "string") return a;
            if (a instanceof Error) return `${a.name}: ${a.message}${a.stack ? `\n${a.stack}` : ""}`;
            try { return JSON.stringify(a); } catch { return String(a); }
        }).join(" ");
    }

    /** Append a line to the persistent log file, rotating if needed. */
    private recordLog(line: string): void {
        try {
            // Rotate if file exceeds max size
            try {
                const stat = fs.statSync(this.logFilePath);
                if (stat.size > MAX_LOG_BYTES) {
                    // Keep the second half of the file
                    const content = fs.readFileSync(this.logFilePath, "utf-8");
                    const lines = content.split("\n");
                    const half = Math.floor(lines.length / 2);
                    fs.writeFileSync(this.logFilePath, lines.slice(half).join("\n"), "utf-8");
                }
            } catch {
                // File doesn't exist yet — that's fine
            }
            fs.appendFileSync(this.logFilePath, line + "\n", "utf-8");
        } catch {
            // Silently ignore write errors to avoid log loops
        }
    }

    /** Log to console (when verbose) and always persist to plugin.log file. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    log(...args: any[]): void {
        const message = this.formatLogArgs(args);
        const timestamp = new Date().toISOString();
        const entry = `[${timestamp}] ${message}`;
        this.recordLog(entry);
        if (this.config.features.verbose !== false) {
            console.log(...args);
        }
    }

    /** Read recent log entries from the persistent log file. */
    readLogs(lines = 50): string[] {
        try {
            if (!fs.existsSync(this.logFilePath)) return [];
            const content = fs.readFileSync(this.logFilePath, "utf-8");
            const allLines = content.split("\n").filter((l) => l.length > 0);
            return allLines.slice(-lines);
        } catch {
            return [];
        }
    }

    /** Search log entries matching a pattern. */
    searchLogs(pattern: string, limit = 50): string[] {
        try {
            if (!fs.existsSync(this.logFilePath)) return [];
            const content = fs.readFileSync(this.logFilePath, "utf-8");
            const regex = new RegExp(pattern, "i");
            const matches = content.split("\n").filter((l) => l.length > 0 && regex.test(l));
            return matches.slice(-limit);
        } catch {
            return [];
        }
    }

    /** Get the path to the log file. */
    getLogFilePath(): string {
        return this.logFilePath;
    }
}
