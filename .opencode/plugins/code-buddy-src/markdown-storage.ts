/**
 * MarkdownStorage — persists memory data as markdown files with YAML frontmatter.
 *
 * Directory layout:
 *   <baseDir>/
 *     entries/          One .md per MemoryEntry
 *     mistakes/         One .md per MistakeRecord
 *     graph.yaml        Knowledge graph (entities + relations)
 *     index.yaml        Auto-generated entry index for fast queries
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { MemoryEntry, Entity, Relation, MistakeRecord, MemoryCategory } from "./types";
import { MEMORY_TYPE_CATEGORY } from "./types";
import type { StorageBackend } from "./storage-interface";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LogFn = (...args: any[]) => void;

// ---- YAML frontmatter parsing/serialization (zero-dependency) ----

/**
 * Parse YAML frontmatter from a markdown string.
 * Returns { data: Record<string, unknown>, content: string }.
 *
 * Supports: scalars, arrays (both `[inline]` and `- item` forms), nested objects are NOT supported.
 */
function parseFrontmatter(raw: string): { data: Record<string, unknown>; content: string } {
    const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!match) return { data: {}, content: raw };

    const yamlBlock = match[1];
    const content = match[2];
    const data: Record<string, unknown> = {};

    const lines = yamlBlock.split("\n");
    let currentKey = "";

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;

        // Array continuation: "  - item"
        if (/^\s+-\s+/.test(line) && currentKey) {
            const val = trimmed.replace(/^-\s+/, "").trim();
            if (!Array.isArray(data[currentKey])) data[currentKey] = [];
            (data[currentKey] as string[]).push(unquoteYaml(val));
            continue;
        }

        const kvMatch = trimmed.match(/^([\w-]+):\s*(.*)/);
        if (!kvMatch) continue;

        const key = kvMatch[1];
        const rawVal = kvMatch[2].trim();
        currentKey = key;

        if (!rawVal) {
            // Could be start of a multi-line array; peek ahead
            if (i + 1 < lines.length && /^\s+-\s+/.test(lines[i + 1])) {
                data[key] = [];
            } else {
                data[key] = "";
            }
            continue;
        }

        // Inline array: [a, b, c]
        if (rawVal.startsWith("[") && rawVal.endsWith("]")) {
            const inner = rawVal.slice(1, -1);
            if (inner.trim() === "") {
                data[key] = [];
            } else {
                data[key] = inner.split(",").map((s) => unquoteYaml(s.trim()));
            }
            continue;
        }

        // Boolean
        if (rawVal === "true") { data[key] = true; continue; }
        if (rawVal === "false") { data[key] = false; continue; }

        // Number
        if (/^-?\d+(\.\d+)?$/.test(rawVal)) { data[key] = Number(rawVal); continue; }

        // String
        data[key] = unquoteYaml(rawVal);
    }

    return { data, content };
}

function unquoteYaml(s: string): string {
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
        return s.slice(1, -1);
    }
    return s;
}

/** Serialize data as YAML frontmatter + markdown body. */
function toFrontmatter(data: Record<string, unknown>, body: string): string {
    const lines: string[] = ["---"];
    for (const [key, val] of Object.entries(data)) {
        if (val === undefined || val === null) continue;
        if (Array.isArray(val)) {
            if (val.length === 0) {
                lines.push(`${key}: []`);
            } else {
                lines.push(`${key}: [${val.map((v) => quoteYaml(String(v))).join(", ")}]`);
            }
        } else {
            lines.push(`${key}: ${quoteYaml(String(val))}`);
        }
    }
    lines.push("---", "");
    return lines.join("\n") + body;
}

function quoteYaml(s: string): string {
    if (/[,:\[\]{}#&*!|>'"@`]/.test(s) || s.includes("\n")) {
        return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    }
    return s;
}

// ---- graph.yaml parsing/serialization ----

interface GraphData {
    entities: Record<string, { type: string; tags: string[]; observations: string[]; created: string }>;
    relations: Array<{ from: string; to: string; type: string; description?: string }>;
}

function parseGraphYaml(raw: string): GraphData {
    const result: GraphData = { entities: {}, relations: [] };
    if (!raw.trim()) return result;

    // Split into entities and relations sections
    const entitySection = raw.match(/entities:\s*\n([\s\S]*?)(?=\nrelations:|$)/);
    const relationSection = raw.match(/relations:\s*\n([\s\S]*?)$/);

    if (entitySection) {
        const entityLines = entitySection[1].split("\n");
        let currentEntity = "";
        let currentField = "";

        for (const line of entityLines) {
            // Top-level entity name (2-space indent)
            const nameMatch = line.match(/^  ([\w-]+):\s*$/);
            if (nameMatch) {
                currentEntity = nameMatch[1];
                result.entities[currentEntity] = { type: "", tags: [], observations: [], created: "" };
                currentField = "";
                continue;
            }

            if (!currentEntity) continue;
            const ent = result.entities[currentEntity];

            // Field: type, tags, observations, created (4-space indent)
            const fieldMatch = line.match(/^    ([\w]+):\s*(.*)/);
            if (fieldMatch) {
                const key = fieldMatch[1];
                const val = fieldMatch[2].trim();
                currentField = key;

                if (key === "type") {
                    ent.type = unquoteYaml(val);
                } else if (key === "created") {
                    ent.created = unquoteYaml(val);
                } else if (key === "tags" || key === "observations") {
                    if (val.startsWith("[") && val.endsWith("]")) {
                        ent[key] = val.slice(1, -1).split(",").map((s) => unquoteYaml(s.trim())).filter(Boolean);
                    } else if (!val) {
                        ent[key] = [];
                    }
                }
                continue;
            }

            // Array item (6-space indent)
            const itemMatch = line.match(/^      - (.*)/);
            if (itemMatch && (currentField === "tags" || currentField === "observations")) {
                ent[currentField].push(unquoteYaml(itemMatch[1].trim()));
            }
        }
    }

    if (relationSection) {
        const relLines = relationSection[1].split("\n");
        let currentRel: Record<string, string> = {};

        for (const line of relLines) {
            const itemStart = line.match(/^  - from:\s*(.*)/);
            if (itemStart) {
                if (currentRel.from) {
                    result.relations.push({
                        from: currentRel.from,
                        to: currentRel.to || "",
                        type: currentRel.type || "",
                        description: currentRel.description,
                    });
                }
                currentRel = { from: unquoteYaml(itemStart[1].trim()) };
                continue;
            }

            const fieldMatch = line.match(/^    (to|type|description):\s*(.*)/);
            if (fieldMatch && currentRel.from !== undefined) {
                currentRel[fieldMatch[1]] = unquoteYaml(fieldMatch[2].trim());
            }
        }

        // Push last relation
        if (currentRel.from) {
            result.relations.push({
                from: currentRel.from,
                to: currentRel.to || "",
                type: currentRel.type || "",
                description: currentRel.description,
            });
        }
    }

    return result;
}

function serializeGraphYaml(entities: Entity[], relations: Relation[]): string {
    const lines: string[] = [
        "# Knowledge Graph — managed by Code-Buddy tooling",
        "# Manual edits are fine but use the tools when possible.",
        "",
        "entities:",
    ];

    for (const e of entities) {
        lines.push(`  ${e.name}:`);
        lines.push(`    type: ${e.type}`);
        if (e.tags.length > 0) {
            lines.push(`    tags: [${e.tags.map((t) => quoteYaml(t)).join(", ")}]`);
        } else {
            lines.push(`    tags: []`);
        }
        if (e.observations.length > 0) {
            lines.push(`    observations:`);
            for (const o of e.observations) {
                lines.push(`      - ${quoteYaml(o)}`);
            }
        } else {
            lines.push(`    observations: []`);
        }
        lines.push(`    created: ${e.createdAt}`);
        lines.push("");
    }

    lines.push("relations:");
    for (const r of relations) {
        lines.push(`  - from: ${r.from}`);
        lines.push(`    to: ${r.to}`);
        lines.push(`    type: ${r.type}`);
        if (r.description) {
            lines.push(`    description: ${quoteYaml(r.description)}`);
        }
        lines.push("");
    }

    return lines.join("\n") + "\n";
}

// ---- index.yaml ----

interface IndexEntry {
    file: string;
    type: string;
    category: string;
    tags: string[];
    title: string;
    date: string;
}

interface IndexData {
    generated: string;
    count: number;
    byType: Record<string, string[]>;
    byTag: Record<string, string[]>;
    entries: Record<string, IndexEntry>;
}

function serializeIndex(memories: MemoryEntry[], filenameMap: Map<string, string>): string {
    const byType: Record<string, string[]> = {};
    const byTag: Record<string, string[]> = {};
    const entries: Record<string, IndexEntry> = {};

    for (const m of memories) {
        // byType
        if (!byType[m.type]) byType[m.type] = [];
        byType[m.type].push(m.id);

        // byTag
        for (const tag of m.tags) {
            if (!byTag[tag]) byTag[tag] = [];
            byTag[tag].push(m.id);
        }

        // entries
        const filename = filenameMap.get(m.id) || `${slugify(m.title)}.md`;
        entries[m.id] = {
            file: filename,
            type: m.type,
            category: m.category || MEMORY_TYPE_CATEGORY[m.type] || "knowledge",
            tags: m.tags,
            title: m.title,
            date: extractDate(m.timestamp),
        };
    }

    const lines: string[] = [
        "# Auto-generated — do not edit manually",
        "# Rebuilt by Code-Buddy on startup and after writes",
        "",
        `generated: ${new Date().toISOString()}`,
        `count: ${memories.length}`,
        "",
        "byType:",
    ];

    for (const [type, ids] of Object.entries(byType)) {
        lines.push(`  ${type}: [${ids.join(", ")}]`);
    }

    lines.push("", "byTag:");
    for (const [tag, ids] of Object.entries(byTag)) {
        lines.push(`  ${tag}: [${ids.join(", ")}]`);
    }

    lines.push("", "entries:");
    for (const [id, entry] of Object.entries(entries)) {
        lines.push(`  ${id}:`);
        lines.push(`    file: ${quoteYaml(entry.file)}`);
        lines.push(`    type: ${entry.type}`);
        lines.push(`    category: ${entry.category}`);
        lines.push(`    tags: [${entry.tags.map((t) => quoteYaml(t)).join(", ")}]`);
        lines.push(`    title: ${quoteYaml(entry.title)}`);
        lines.push(`    date: ${entry.date}`);
    }

    return lines.join("\n") + "\n";
}

// ---- Slug / filename helpers ----

function slugify(text: string): string {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, "")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .substring(0, 50);
}

function extractDate(timestamp: string): string {
    try {
        const d = new Date(timestamp);
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, "0");
        const dd = String(d.getDate()).padStart(2, "0");
        return `${yyyy}-${mm}-${dd}`;
    } catch {
        return "unknown";
    }
}

function memoryToFilename(m: MemoryEntry): string {
    const date = extractDate(m.timestamp);
    const slug = slugify(m.title);
    return `${date}-${slug || m.id}.md`;
}

function mistakeToFilename(m: MistakeRecord): string {
    const date = extractDate(m.timestamp);
    const slug = slugify(m.action);
    return `${date}-${slug || m.id}.md`;
}

/** Ensure filename is unique within a directory by appending -2, -3, etc. */
function uniqueFilename(dir: string, filename: string, existingNames: Set<string>): string {
    if (!existingNames.has(filename)) return filename;
    const base = filename.replace(/\.md$/, "");
    let counter = 2;
    while (existingNames.has(`${base}-${counter}.md`)) counter++;
    return `${base}-${counter}.md`;
}

// ---- Memory <-> Markdown conversion ----

function memoryToMarkdown(m: MemoryEntry): string {
    const frontmatter: Record<string, unknown> = {
        id: m.id,
        type: m.type,
        category: m.category || MEMORY_TYPE_CATEGORY[m.type] || "knowledge",
        tags: m.tags,
        date: extractDate(m.timestamp),
        timestamp: m.timestamp,
    };

    const body = `## ${m.title}\n\n${m.content}\n`;
    return toFrontmatter(frontmatter, body);
}

function markdownToMemory(raw: string): MemoryEntry | null {
    const { data, content } = parseFrontmatter(raw);
    if (!data.id || !data.type) return null;

    // Extract title from first ## heading or use id
    const headingMatch = content.match(/^##\s+(.+)/m);
    const title = headingMatch ? headingMatch[1].trim() : String(data.id);

    // Content is everything after the first heading
    let bodyContent = content;
    if (headingMatch) {
        const headingIdx = content.indexOf(headingMatch[0]);
        bodyContent = content.substring(headingIdx + headingMatch[0].length).trim();
    }

    return {
        id: String(data.id),
        type: String(data.type) as MemoryEntry["type"],
        category: (data.category as MemoryCategory) || undefined,
        title,
        content: bodyContent,
        tags: Array.isArray(data.tags) ? data.tags.map(String) : [],
        timestamp: String(data.timestamp || data.date || new Date().toISOString()),
    };
}

// ---- Mistake <-> Markdown conversion ----

function mistakeToMarkdown(m: MistakeRecord): string {
    const frontmatter: Record<string, unknown> = {
        id: m.id,
        errorType: m.errorType,
        date: extractDate(m.timestamp),
        timestamp: m.timestamp,
    };
    if (m.relatedRule) frontmatter.relatedRule = m.relatedRule;

    const body = `## ${m.action}

**Action taken:** ${m.action}

**What went wrong:** ${m.userCorrection}

**Correct method:** ${m.correctMethod}

**Impact:** ${m.impact}

**Prevention:** ${m.preventionMethod}
`;
    return toFrontmatter(frontmatter, body);
}

function markdownToMistake(raw: string): MistakeRecord | null {
    const { data, content } = parseFrontmatter(raw);
    if (!data.id || !data.errorType) return null;

    // Parse structured sections from body
    const extract = (label: string): string => {
        const re = new RegExp(`\\*\\*${label}:\\*\\*\\s*(.+)`, "i");
        const match = content.match(re);
        return match ? match[1].trim() : "";
    };

    return {
        id: String(data.id),
        timestamp: String(data.timestamp || data.date || new Date().toISOString()),
        action: extract("Action taken") || String(data.id),
        errorType: String(data.errorType) as MistakeRecord["errorType"],
        userCorrection: extract("What went wrong"),
        correctMethod: extract("Correct method"),
        impact: extract("Impact"),
        preventionMethod: extract("Prevention"),
        relatedRule: data.relatedRule ? String(data.relatedRule) : undefined,
    };
}

// ============================================
// MarkdownStorage class
// ============================================

export class MarkdownStorage implements StorageBackend {
    private baseDir: string;
    private entriesDir: string;
    private mistakesDir: string;
    private graphPath: string;
    private indexPath: string;
    private log: LogFn;

    /** Maps memory ID → filename for stable file references. */
    private memoryFilenameMap = new Map<string, string>();
    /** Maps mistake ID → filename. */
    private mistakeFilenameMap = new Map<string, string>();

    constructor(dataDir: string, log: LogFn = console.log) {
        this.baseDir = dataDir;
        this.entriesDir = path.join(dataDir, "entries");
        this.mistakesDir = path.join(dataDir, "mistakes");
        this.graphPath = path.join(dataDir, "graph.yaml");
        this.indexPath = path.join(dataDir, "index.yaml");
        this.log = log;
        this.ensureDirs();
    }

    getBaseDir(): string {
        return this.baseDir;
    }

    private ensureDirs(): void {
        for (const dir of [this.baseDir, this.entriesDir, this.mistakesDir]) {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        }
    }

    // ---- Memory entries ----

    readMemories(): MemoryEntry[] {
        this.ensureDirs();
        const memories: MemoryEntry[] = [];

        try {
            const files = fs.readdirSync(this.entriesDir).filter((f) => f.endsWith(".md")).sort();
            for (const file of files) {
                try {
                    const raw = fs.readFileSync(path.join(this.entriesDir, file), "utf-8");
                    const entry = markdownToMemory(raw);
                    if (entry) {
                        memories.push(entry);
                        this.memoryFilenameMap.set(entry.id, file);
                    }
                } catch (err) {
                    this.log(`[code-buddy] Error reading entry ${file}:`, err);
                }
            }
        } catch (err) {
            this.log("[code-buddy] Error reading entries directory:", err);
        }

        return memories;
    }

    writeMemories(memories: MemoryEntry[]): void {
        this.ensureDirs();

        // Determine current files on disk
        const existingFiles = new Set<string>();
        try {
            for (const f of fs.readdirSync(this.entriesDir)) {
                if (f.endsWith(".md")) existingFiles.add(f);
            }
        } catch { /* dir may not exist yet */ }

        // Track which files should remain
        const keepFiles = new Set<string>();
        const usedFilenames = new Set<string>();

        for (const m of memories) {
            // Reuse existing filename if we know it, otherwise generate
            let filename = this.memoryFilenameMap.get(m.id);
            if (!filename || !existingFiles.has(filename)) {
                filename = memoryToFilename(m);
                filename = uniqueFilename(this.entriesDir, filename, usedFilenames);
            }
            usedFilenames.add(filename);
            this.memoryFilenameMap.set(m.id, filename);
            keepFiles.add(filename);

            try {
                fs.writeFileSync(path.join(this.entriesDir, filename), memoryToMarkdown(m), "utf-8");
            } catch (err) {
                this.log(`[code-buddy] Error writing entry ${filename}:`, err);
            }
        }

        // Remove files that no longer have a corresponding memory
        for (const file of existingFiles) {
            if (!keepFiles.has(file)) {
                try {
                    fs.unlinkSync(path.join(this.entriesDir, file));
                } catch { /* best effort */ }
            }
        }

        // Rebuild index
        this.writeIndex(memories);
    }

    // ---- Knowledge graph ----

    readEntities(): Entity[] {
        try {
            if (!fs.existsSync(this.graphPath)) return [];
            const raw = fs.readFileSync(this.graphPath, "utf-8");
            const graph = parseGraphYaml(raw);

            return Object.entries(graph.entities).map(([name, data]) => ({
                id: `entity_${name}`,
                name,
                type: data.type as Entity["type"],
                observations: data.observations,
                tags: data.tags,
                createdAt: data.created || new Date().toISOString(),
            }));
        } catch (err) {
            this.log("[code-buddy] Error reading graph.yaml entities:", err);
            return [];
        }
    }

    writeEntities(entities: Entity[]): void {
        this.writeGraph(entities, this.readRelationsRaw());
    }

    readRelations(): Relation[] {
        return this.readRelationsRaw();
    }

    private readRelationsRaw(): Relation[] {
        try {
            if (!fs.existsSync(this.graphPath)) return [];
            const raw = fs.readFileSync(this.graphPath, "utf-8");
            const graph = parseGraphYaml(raw);

            return graph.relations.map((r, i) => ({
                id: `rel_${i}`,
                from: r.from,
                to: r.to,
                type: r.type,
                description: r.description,
                createdAt: new Date().toISOString(),
            }));
        } catch (err) {
            this.log("[code-buddy] Error reading graph.yaml relations:", err);
            return [];
        }
    }

    writeRelations(relations: Relation[]): void {
        this.writeGraph(this.readEntities(), relations);
    }

    private writeGraph(entities: Entity[], relations: Relation[]): void {
        this.ensureDirs();
        try {
            const yaml = serializeGraphYaml(entities, relations);
            fs.writeFileSync(this.graphPath, yaml, "utf-8");
        } catch (err) {
            this.log("[code-buddy] Error writing graph.yaml:", err);
        }
    }

    // ---- Mistake records ----

    readMistakes(): MistakeRecord[] {
        this.ensureDirs();
        const mistakes: MistakeRecord[] = [];

        try {
            const files = fs.readdirSync(this.mistakesDir).filter((f) => f.endsWith(".md")).sort();
            for (const file of files) {
                try {
                    const raw = fs.readFileSync(path.join(this.mistakesDir, file), "utf-8");
                    const record = markdownToMistake(raw);
                    if (record) {
                        mistakes.push(record);
                        this.mistakeFilenameMap.set(record.id, file);
                    }
                } catch (err) {
                    this.log(`[code-buddy] Error reading mistake ${file}:`, err);
                }
            }
        } catch (err) {
            this.log("[code-buddy] Error reading mistakes directory:", err);
        }

        return mistakes;
    }

    writeMistakes(mistakes: MistakeRecord[]): void {
        this.ensureDirs();

        const existingFiles = new Set<string>();
        try {
            for (const f of fs.readdirSync(this.mistakesDir)) {
                if (f.endsWith(".md")) existingFiles.add(f);
            }
        } catch { /* dir may not exist yet */ }

        const keepFiles = new Set<string>();
        const usedFilenames = new Set<string>();

        for (const m of mistakes) {
            let filename = this.mistakeFilenameMap.get(m.id);
            if (!filename || !existingFiles.has(filename)) {
                filename = mistakeToFilename(m);
                filename = uniqueFilename(this.mistakesDir, filename, usedFilenames);
            }
            usedFilenames.add(filename);
            this.mistakeFilenameMap.set(m.id, filename);
            keepFiles.add(filename);

            try {
                fs.writeFileSync(path.join(this.mistakesDir, filename), mistakeToMarkdown(m), "utf-8");
            } catch (err) {
                this.log(`[code-buddy] Error writing mistake ${filename}:`, err);
            }
        }

        for (const file of existingFiles) {
            if (!keepFiles.has(file)) {
                try {
                    fs.unlinkSync(path.join(this.mistakesDir, file));
                } catch { /* best effort */ }
            }
        }
    }

    // ---- Index ----

    private writeIndex(memories: MemoryEntry[]): void {
        try {
            const yaml = serializeIndex(memories, this.memoryFilenameMap);
            fs.writeFileSync(this.indexPath, yaml, "utf-8");
        } catch (err) {
            this.log("[code-buddy] Error writing index.yaml:", err);
        }
    }
}

// ---- Exported helpers for migration ----

export { parseFrontmatter, toFrontmatter, memoryToMarkdown, markdownToMemory, mistakeToMarkdown, markdownToMistake, serializeGraphYaml, parseGraphYaml };
