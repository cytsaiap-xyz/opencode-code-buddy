/**
 * Knowledge Graph System
 * 
 * Simple knowledge graph implementation for managing entities and relationships.
 * Fully offline, uses local JSON storage.
 */

import { LocalStorage, createProjectStorage } from "../utils/storage.js";
import { SimpleSearch, type SearchResult } from "../utils/search.js";

/**
 * Entity type
 */
export type EntityType =
    | "decision"      // Decision
    | "feature"       // Feature
    | "component"     // Component
    | "file"          // File
    | "bug_fix"       // Bug fix
    | "lesson"        // Lesson
    | "pattern"       // Design pattern
    | "technology"    // Technology
    | "person"        // Person
    | "custom";       // Custom

/**
 * Entity interface
 */
export interface Entity {
    name: string;
    type: EntityType;
    observations: string[];
    tags: string[];
    createdAt: number;
    updatedAt: number;
    metadata?: Record<string, unknown>;
}

/**
 * Relation type
 */
export type RelationType =
    | "depends_on"     // Depends on
    | "implements"     // Implements
    | "related_to"     // Related to
    | "caused_by"      // Caused by
    | "fixed_by"       // Fixed by
    | "uses"           // Uses
    | "extends"        // Extends
    | "created_by"     // Created by
    | "custom";        // Custom

/**
 * Relation interface
 */
export interface Relation {
    from: string;
    to: string;
    type: RelationType;
    description?: string;
    createdAt: number;
}

/**
 * Knowledge graph data structure
 */
interface GraphData {
    version: number;
    entities: Record<string, Entity>;
    relations: Relation[];
    lastUpdated: number;
}

const GRAPH_FILE = "graph.json";
const CURRENT_VERSION = 1;

/**
 * Knowledge Graph Manager
 */
export class KnowledgeGraph {
    private storage: LocalStorage<unknown>;
    private search: SimpleSearch<Entity>;
    private data: GraphData;

    constructor(projectDir: string) {
        this.storage = createProjectStorage(projectDir);
        this.search = new SimpleSearch<Entity>(
            (entity) => `${entity.name} ${entity.observations.join(" ")} ${entity.tags.join(" ")}`
        );
        this.data = this.load();
        this.search.setItems(Object.values(this.data.entities));
    }

    /**
     * Load graph data
     */
    private load(): GraphData {
        const defaultData: GraphData = {
            version: CURRENT_VERSION,
            entities: {},
            relations: [],
            lastUpdated: Date.now()
        };

        return this.storage.read<GraphData>(GRAPH_FILE, defaultData);
    }

    /**
     * Save graph data
     */
    private save(): boolean {
        this.data.lastUpdated = Date.now();
        return this.storage.write(GRAPH_FILE, this.data);
    }

    // ========================================
    // Entity Operations
    // ========================================

    /**
     * Create entity
     */
    createEntity(
        name: string,
        type: EntityType,
        observations: string[],
        tags: string[] = [],
        metadata?: Record<string, unknown>
    ): Entity {
        const now = Date.now();
        const entity: Entity = {
            name,
            type,
            observations,
            tags,
            createdAt: now,
            updatedAt: now,
            metadata
        };

        this.data.entities[name] = entity;
        this.search.addItem(entity);
        this.save();

        return entity;
    }

    /**
     * Get entity
     */
    getEntity(name: string): Entity | undefined {
        return this.data.entities[name];
    }

    /**
     * Update entity
     */
    updateEntity(
        name: string,
        updates: Partial<Omit<Entity, "name" | "createdAt">>
    ): boolean {
        const entity = this.data.entities[name];
        if (!entity) return false;

        this.data.entities[name] = {
            ...entity,
            ...updates,
            updatedAt: Date.now()
        };

        this.search.setItems(Object.values(this.data.entities));
        return this.save();
    }

    /**
     * Add observation to entity
     */
    addObservation(name: string, observation: string): boolean {
        const entity = this.data.entities[name];
        if (!entity) return false;

        entity.observations.push(observation);
        entity.updatedAt = Date.now();

        return this.save();
    }

    /**
     * Delete entity
     */
    deleteEntity(name: string): boolean {
        if (!this.data.entities[name]) return false;

        delete this.data.entities[name];

        // Delete related relations
        this.data.relations = this.data.relations.filter(
            r => r.from !== name && r.to !== name
        );

        this.search.setItems(Object.values(this.data.entities));
        return this.save();
    }

    /**
     * Search entities
     */
    searchEntities(query: string, limit: number = 10): SearchResult<Entity>[] {
        return this.search.search(query, { limit, minScore: 0.1 });
    }

    /**
     * Get entities by type
     */
    getEntitiesByType(type: EntityType): Entity[] {
        return Object.values(this.data.entities).filter(e => e.type === type);
    }

    /**
     * Get entities by tag
     */
    getEntitiesByTag(tag: string): Entity[] {
        return Object.values(this.data.entities).filter(e =>
            e.tags.some(t => t.toLowerCase().includes(tag.toLowerCase()))
        );
    }

    /**
     * Get all entities
     */
    getAllEntities(): Entity[] {
        return Object.values(this.data.entities);
    }

    // ========================================
    // Relation Operations
    // ========================================

    /**
     * Create relation
     */
    createRelation(
        from: string,
        to: string,
        type: RelationType,
        description?: string
    ): Relation | null {
        // Ensure entities exist
        if (!this.data.entities[from] || !this.data.entities[to]) {
            return null;
        }

        // Check if relation already exists
        const exists = this.data.relations.some(
            r => r.from === from && r.to === to && r.type === type
        );
        if (exists) return null;

        const relation: Relation = {
            from,
            to,
            type,
            description,
            createdAt: Date.now()
        };

        this.data.relations.push(relation);
        this.save();

        return relation;
    }

    /**
     * Get relations for entity
     */
    getRelations(entityName: string): {
        outgoing: Relation[];
        incoming: Relation[];
    } {
        return {
            outgoing: this.data.relations.filter(r => r.from === entityName),
            incoming: this.data.relations.filter(r => r.to === entityName)
        };
    }

    /**
     * Delete relation
     */
    deleteRelation(from: string, to: string, type: RelationType): boolean {
        const index = this.data.relations.findIndex(
            r => r.from === from && r.to === to && r.type === type
        );

        if (index === -1) return false;

        this.data.relations.splice(index, 1);
        return this.save();
    }

    /**
     * Get all relations
     */
    getAllRelations(): Relation[] {
        return [...this.data.relations];
    }

    // ========================================
    // Graph Analysis
    // ========================================

    /**
     * Get all related entities (one level)
     */
    getRelatedEntities(entityName: string): Entity[] {
        const relatedNames = new Set<string>();

        for (const relation of this.data.relations) {
            if (relation.from === entityName) {
                relatedNames.add(relation.to);
            }
            if (relation.to === entityName) {
                relatedNames.add(relation.from);
            }
        }

        return Array.from(relatedNames)
            .map(name => this.data.entities[name])
            .filter((e): e is Entity => e !== undefined);
    }

    /**
     * Get statistics
     */
    getStats(): {
        entityCount: number;
        relationCount: number;
        byType: Record<string, number>;
        lastUpdated: number;
    } {
        const byType: Record<string, number> = {};

        for (const entity of Object.values(this.data.entities)) {
            byType[entity.type] = (byType[entity.type] || 0) + 1;
        }

        return {
            entityCount: Object.keys(this.data.entities).length,
            relationCount: this.data.relations.length,
            byType,
            lastUpdated: this.data.lastUpdated
        };
    }

    // ========================================
    // Formatting
    // ========================================

    /**
     * Format entity as readable string
     */
    formatEntity(entity: Entity): string {
        const typeEmoji: Record<EntityType, string> = {
            decision: "🎯",
            feature: "✨",
            component: "🧩",
            file: "📄",
            bug_fix: "🐛",
            lesson: "📚",
            pattern: "🏗️",
            technology: "💻",
            person: "👤",
            custom: "📌"
        };

        const date = new Date(entity.createdAt).toLocaleDateString("en-US");
        const observations = entity.observations.map(o => `  • ${o}`).join("\n");

        return `${typeEmoji[entity.type]} **${entity.name}**
📅 Created ${date} | 🏷️ ${entity.tags.join(", ") || "No tags"}

**Observations:**
${observations}`;
    }

    /**
     * Format search results
     */
    formatSearchResults(results: SearchResult<Entity>[]): string {
        if (results.length === 0) {
            return "🔍 No related entities found";
        }

        const formatted = results.map((r, i) => {
            const scoreBar = "█".repeat(Math.round(r.score * 5)) + "░".repeat(5 - Math.round(r.score * 5));
            return `### ${i + 1}. ${this.formatEntity(r.item)}
Relevance: ${scoreBar} (${(r.score * 100).toFixed(0)}%)`;
        });

        return `🔍 Found ${results.length} related entities\n\n${formatted.join("\n\n---\n\n")}`;
    }
}
