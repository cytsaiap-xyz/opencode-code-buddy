/**
 * Buddy Remember Command
 * 
 * Query project memory and knowledge graph to recall past decisions, patterns, and lessons.
 */

import { ProjectMemory, type MemoryType, type MemoryEntry } from "../memory/project-memory.js";
import { KnowledgeGraph, type Entity } from "../memory/knowledge-graph.js";
import type { SearchResult } from "../utils/search.js";

/**
 * Query options
 */
export interface QueryOptions {
    limit?: number;
    type?: MemoryType;
}

/**
 * Query result
 */
export interface QueryResult {
    success: boolean;
    memories: SearchResult<MemoryEntry>[];
    entities: SearchResult<Entity>[];
    message: string;
}

/**
 * Buddy Remember Command Handler
 */
export class BuddyRememberCommand {
    private memory: ProjectMemory;
    private graph: KnowledgeGraph;

    constructor(memory: ProjectMemory, graph: KnowledgeGraph) {
        this.memory = memory;
        this.graph = graph;
    }

    /**
     * Query memories and entities
     */
    async query(queryText: string, options: QueryOptions = {}): Promise<QueryResult> {
        const { limit = 5, type } = options;

        // Search memories
        let memories = this.memory.search_memories(queryText, limit);

        // Filter by type if specified
        if (type) {
            memories = memories.filter(m => m.item.type === type);
        }

        // Search entities
        const entities = this.graph.searchEntities(queryText, limit);

        // Format result message
        const message = this.formatQueryResult(queryText, memories, entities);

        return {
            success: true,
            memories,
            entities,
            message
        };
    }

    /**
     * Get recent memories
     */
    getRecent(limit: number = 5): { memories: MemoryEntry[]; message: string } {
        const memories = this.memory.getRecent(limit);
        const message = this.formatRecentMemories(memories);
        return { memories, message };
    }

    /**
     * Get memories by type
     */
    getByType(type: MemoryType, limit: number = 10): { memories: MemoryEntry[]; message: string } {
        const memories = this.memory.getByType(type, limit);
        const message = this.formatMemoriesByType(type, memories);
        return { memories, message };
    }

    /**
     * Get statistics
     */
    getStats(): string {
        const memoryStats = this.memory.getStats();
        const graphStats = this.graph.getStats();

        return `## 📊 Project Memory Statistics

### 🧠 Memory
- **Total entries**: ${memoryStats.total}
- **Recent (7 days)**: ${memoryStats.recentCount}

**By Type:**
| Type | Count |
|------|-------|
| Decisions | ${memoryStats.byType.decision} |
| Patterns | ${memoryStats.byType.pattern} |
| Bug Fixes | ${memoryStats.byType.bugfix} |
| Lessons | ${memoryStats.byType.lesson} |
| Features | ${memoryStats.byType.feature} |
| Notes | ${memoryStats.byType.note} |

---

### 🔗 Knowledge Graph
- **Entities**: ${graphStats.entityCount}
- **Relations**: ${graphStats.relationCount}

**Entity Types:**
${Object.entries(graphStats.byType).map(([type, count]) => `- ${type}: ${count}`).join("\n")}

---

📅 Last updated: ${new Date(memoryStats.lastUpdated).toLocaleString("en-US")}`;
    }

    /**
     * Format query result
     */
    private formatQueryResult(
        query: string,
        memories: SearchResult<MemoryEntry>[],
        entities: SearchResult<Entity>[]
    ): string {
        const hasResults = memories.length > 0 || entities.length > 0;

        if (!hasResults) {
            return `## 🔍 Searching "${query}"

No related memories or entities found.

**Suggestions:**
- Try different keywords
- Use \`buddy_remember_recent()\` to view recent memories
- Use \`buddy_remember_stats()\` to view memory statistics`;
        }

        let message = `## 🔍 Search Results for "${query}"\n\n`;

        if (memories.length > 0) {
            message += `### 🧠 Related Memories (${memories.length})\n\n`;
            for (const result of memories) {
                const entry = result.item;
                const date = new Date(entry.timestamp).toLocaleDateString("en-US");
                const score = (result.score * 100).toFixed(0);
                message += `#### ${this.getTypeEmoji(entry.type)} ${entry.title}
- **Type**: ${entry.type}
- **Date**: ${date}
- **Relevance**: ${score}%
- **Tags**: ${entry.tags.join(", ")}

${entry.content.substring(0, 200)}${entry.content.length > 200 ? "..." : ""}

---

`;
            }
        }

        if (entities.length > 0) {
            message += `### 🔗 Related Entities (${entities.length})\n\n`;
            for (const result of entities) {
                const entity = result.item;
                const score = (result.score * 100).toFixed(0);
                message += `#### ${entity.name}
- **Type**: ${entity.type}
- **Relevance**: ${score}%
- **Observations**: ${entity.observations.slice(0, 3).join("; ")}

---

`;
            }
        }

        return message;
    }

    /**
     * Format recent memories
     */
    private formatRecentMemories(memories: MemoryEntry[]): string {
        if (memories.length === 0) {
            return `## 📜 Recent Memories

No memories yet. Use \`buddy_do\` to start recording!`;
        }

        let message = `## 📜 Recent Memories (${memories.length})\n\n`;

        for (const entry of memories) {
            const date = new Date(entry.timestamp).toLocaleDateString("en-US");
            message += `### ${this.getTypeEmoji(entry.type)} ${entry.title}
- **Date**: ${date}
- **Type**: ${entry.type}
- **Tags**: ${entry.tags.join(", ")}

${entry.content.substring(0, 150)}${entry.content.length > 150 ? "..." : ""}

---

`;
        }

        return message;
    }

    /**
     * Format memories by type
     */
    private formatMemoriesByType(type: MemoryType, memories: MemoryEntry[]): string {
        const typeNames: Record<MemoryType, string> = {
            decision: "Decisions",
            pattern: "Patterns",
            bugfix: "Bug Fixes",
            lesson: "Lessons Learned",
            feature: "Features",
            note: "Notes"
        };

        if (memories.length === 0) {
            return `## ${this.getTypeEmoji(type)} ${typeNames[type]}

No ${typeNames[type].toLowerCase()} recorded yet.`;
        }

        let message = `## ${this.getTypeEmoji(type)} ${typeNames[type]} (${memories.length})\n\n`;

        for (const entry of memories) {
            const date = new Date(entry.timestamp).toLocaleDateString("en-US");
            message += `### ${entry.title}
- **Date**: ${date}
- **Tags**: ${entry.tags.join(", ")}

${entry.content.substring(0, 150)}${entry.content.length > 150 ? "..." : ""}

---

`;
        }

        return message;
    }

    /**
     * Get type emoji
     */
    private getTypeEmoji(type: MemoryType): string {
        const emojis: Record<MemoryType, string> = {
            decision: "🎯",
            pattern: "🏗️",
            bugfix: "🐛",
            lesson: "📚",
            feature: "✨",
            note: "📝"
        };
        return emojis[type] || "📌";
    }
}
