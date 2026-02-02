/**
 * Project Memory System
 * 
 * Project memory system for storing and retrieving project-related decisions,
 * patterns, bug fixes, and lessons learned.
 * Fully offline, uses local JSON storage.
 */

import { LocalStorage, createProjectStorage } from "../utils/storage.js";
import { SimpleSearch, type SearchResult } from "../utils/search.js";

/**
 * Memory entry type
 */
export type MemoryType =
    | "decision"    // Technical decision
    | "pattern"     // Architecture/design pattern
    | "bugfix"      // Bug fix
    | "lesson"      // Lesson learned
    | "feature"     // Feature implementation
    | "note";       // General note

/**
 * Memory entry interface
 */
export interface MemoryEntry {
    id: string;
    timestamp: number;
    type: MemoryType;
    title: string;
    content: string;
    tags: string[];
    metadata?: Record<string, unknown>;
}

/**
 * Memory data structure
 */
interface MemoryData {
    version: number;
    entries: MemoryEntry[];
    lastUpdated: number;
}

const MEMORY_FILE = "memory.json";
const CURRENT_VERSION = 1;

/**
 * Project Memory Manager
 */
export class ProjectMemory {
    private storage: LocalStorage<unknown>;
    private search: SimpleSearch<MemoryEntry>;
    private data: MemoryData;

    constructor(projectDir: string) {
        this.storage = createProjectStorage(projectDir);
        this.search = new SimpleSearch<MemoryEntry>(
            (entry) => `${entry.title} ${entry.content} ${entry.tags.join(" ")}`
        );
        this.data = this.load();
        this.search.setItems(this.data.entries);
    }

    /**
     * Load memory data
     */
    private load(): MemoryData {
        const defaultData: MemoryData = {
            version: CURRENT_VERSION,
            entries: [],
            lastUpdated: Date.now()
        };

        return this.storage.read<MemoryData>(MEMORY_FILE, defaultData);
    }

    /**
     * Save memory data
     */
    private save(): boolean {
        this.data.lastUpdated = Date.now();
        return this.storage.write(MEMORY_FILE, this.data);
    }

    /**
     * Generate unique ID
     */
    private generateId(): string {
        return `mem_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    }

    /**
     * Add memory
     */
    add(entry: Omit<MemoryEntry, "id" | "timestamp">): MemoryEntry {
        const newEntry: MemoryEntry = {
            ...entry,
            id: this.generateId(),
            timestamp: Date.now()
        };

        this.data.entries.push(newEntry);
        this.search.addItem(newEntry);
        this.save();

        return newEntry;
    }

    /**
     * Record a decision
     */
    recordDecision(
        title: string,
        content: string,
        tags: string[] = [],
        metadata?: Record<string, unknown>
    ): MemoryEntry {
        return this.add({
            type: "decision",
            title,
            content,
            tags: ["decision", ...tags],
            metadata
        });
    }

    /**
     * Record a bug fix
     */
    recordBugfix(
        title: string,
        content: string,
        tags: string[] = [],
        metadata?: Record<string, unknown>
    ): MemoryEntry {
        return this.add({
            type: "bugfix",
            title,
            content,
            tags: ["bugfix", ...tags],
            metadata
        });
    }

    /**
     * Record a lesson learned
     */
    recordLesson(
        title: string,
        content: string,
        tags: string[] = [],
        metadata?: Record<string, unknown>
    ): MemoryEntry {
        return this.add({
            type: "lesson",
            title,
            content,
            tags: ["lesson", ...tags],
            metadata
        });
    }

    /**
     * Record a feature implementation
     */
    recordFeature(
        title: string,
        content: string,
        tags: string[] = [],
        metadata?: Record<string, unknown>
    ): MemoryEntry {
        return this.add({
            type: "feature",
            title,
            content,
            tags: ["feature", ...tags],
            metadata
        });
    }

    /**
     * Search memories
     */
    search_memories(query: string, limit: number = 10): SearchResult<MemoryEntry>[] {
        return this.search.search(query, { limit, minScore: 0.1 });
    }

    /**
     * Get memories by type
     */
    getByType(type: MemoryType, limit?: number): MemoryEntry[] {
        const filtered = this.data.entries.filter(e => e.type === type);
        const sorted = filtered.sort((a, b) => b.timestamp - a.timestamp);
        return limit ? sorted.slice(0, limit) : sorted;
    }

    /**
     * Get memories by tag
     */
    getByTag(tag: string, limit?: number): MemoryEntry[] {
        const filtered = this.data.entries.filter(e =>
            e.tags.some(t => t.toLowerCase().includes(tag.toLowerCase()))
        );
        const sorted = filtered.sort((a, b) => b.timestamp - a.timestamp);
        return limit ? sorted.slice(0, limit) : sorted;
    }

    /**
     * Get recent memories
     */
    getRecent(limit: number = 10): MemoryEntry[] {
        return [...this.data.entries]
            .sort((a, b) => b.timestamp - a.timestamp)
            .slice(0, limit);
    }

    /**
     * Get all memories
     */
    getAll(): MemoryEntry[] {
        return [...this.data.entries];
    }

    /**
     * Get memory by ID
     */
    getById(id: string): MemoryEntry | undefined {
        return this.data.entries.find(e => e.id === id);
    }

    /**
     * Update memory
     */
    update(id: string, updates: Partial<Omit<MemoryEntry, "id" | "timestamp">>): boolean {
        const index = this.data.entries.findIndex(e => e.id === id);
        if (index === -1) return false;

        this.data.entries[index] = {
            ...this.data.entries[index],
            ...updates
        };

        this.search.setItems(this.data.entries);
        return this.save();
    }

    /**
     * Delete memory
     */
    delete(id: string): boolean {
        const index = this.data.entries.findIndex(e => e.id === id);
        if (index === -1) return false;

        this.data.entries.splice(index, 1);
        this.search.setItems(this.data.entries);
        return this.save();
    }

    /**
     * Get statistics
     */
    getStats(): {
        total: number;
        byType: Record<MemoryType, number>;
        recentCount: number;
        lastUpdated: number;
    } {
        const byType: Record<MemoryType, number> = {
            decision: 0,
            pattern: 0,
            bugfix: 0,
            lesson: 0,
            feature: 0,
            note: 0
        };

        for (const entry of this.data.entries) {
            byType[entry.type]++;
        }

        const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
        const recentCount = this.data.entries.filter(e => e.timestamp > oneWeekAgo).length;

        return {
            total: this.data.entries.length,
            byType,
            recentCount,
            lastUpdated: this.data.lastUpdated
        };
    }

    /**
     * Format memory entry as readable string
     */
    formatEntry(entry: MemoryEntry): string {
        const date = new Date(entry.timestamp).toLocaleDateString("en-US");
        const typeEmoji: Record<MemoryType, string> = {
            decision: "🎯",
            pattern: "🏗️",
            bugfix: "🐛",
            lesson: "📚",
            feature: "✨",
            note: "📝"
        };

        return `${typeEmoji[entry.type]} **${entry.title}**
📅 ${date} | 🏷️ ${entry.tags.join(", ")}
${entry.content}`;
    }

    /**
     * Format search results
     */
    formatSearchResults(results: SearchResult<MemoryEntry>[]): string {
        if (results.length === 0) {
            return "🔍 No related memories found";
        }

        const formatted = results.map((r, i) => {
            const scoreBar = "█".repeat(Math.round(r.score * 5)) + "░".repeat(5 - Math.round(r.score * 5));
            return `### ${i + 1}. ${this.formatEntry(r.item)}
Relevance: ${scoreBar} (${(r.score * 100).toFixed(0)}%)`;
        });

        return `🔍 Found ${results.length} related memories\n\n${formatted.join("\n\n---\n\n")}`;
    }
}
