/**
 * StorageBackend interface — abstracts how memory data is persisted.
 *
 * Both LocalStorage (JSON) and MarkdownStorage implement this interface,
 * so the rest of the plugin (state, tools, hooks) can swap between them
 * via a config flag without changing any business logic.
 */

import type { MemoryEntry, Entity, Relation, MistakeRecord } from "./types";

export interface StorageBackend {
    /** Get the base data directory path. */
    getBaseDir(): string;

    // ---- Memory entries ----
    readMemories(): MemoryEntry[];
    writeMemories(memories: MemoryEntry[]): void;

    // ---- Knowledge graph ----
    readEntities(): Entity[];
    writeEntities(entities: Entity[]): void;
    readRelations(): Relation[];
    writeRelations(relations: Relation[]): void;

    // ---- Mistake records ----
    readMistakes(): MistakeRecord[];
    writeMistakes(mistakes: MistakeRecord[]): void;
}

/**
 * Adapter that wraps the existing LocalStorage class to conform to StorageBackend.
 */
export class JsonStorageBackend implements StorageBackend {
    constructor(private storage: import("./storage").LocalStorage) {}

    getBaseDir(): string {
        return this.storage.getBaseDir();
    }

    readMemories(): MemoryEntry[] {
        return this.storage.read("memory.json", []);
    }
    writeMemories(memories: MemoryEntry[]): void {
        this.storage.write("memory.json", memories);
    }

    readEntities(): Entity[] {
        return this.storage.read("entities.json", []);
    }
    writeEntities(entities: Entity[]): void {
        this.storage.write("entities.json", entities);
    }

    readRelations(): Relation[] {
        return this.storage.read("relations.json", []);
    }
    writeRelations(relations: Relation[]): void {
        this.storage.write("relations.json", relations);
    }

    readMistakes(): MistakeRecord[] {
        return this.storage.read("mistakes.json", []);
    }
    writeMistakes(mistakes: MistakeRecord[]): void {
        this.storage.write("mistakes.json", mistakes);
    }
}
