/**
 * Local JSON Storage Utility
 * 
 * Provides simple local JSON file storage functionality, fully offline.
 * Uses Node.js fs module, no additional dependencies required.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface StorageOptions {
    /** Data directory path */
    dataDir: string;
    /** Whether to auto-backup */
    autoBackup?: boolean;
}

export class LocalStorage<T> {
    private dataDir: string;
    private autoBackup: boolean;
    private cache: Map<string, T> = new Map();

    constructor(options: StorageOptions) {
        this.dataDir = options.dataDir;
        this.autoBackup = options.autoBackup ?? true;
        this.ensureDataDir();
    }

    /**
     * Ensure data directory exists
     */
    private ensureDataDir(): void {
        if (!existsSync(this.dataDir)) {
            mkdirSync(this.dataDir, { recursive: true });
        }
    }

    /**
     * Get full file path
     */
    private getFilePath(filename: string): string {
        return join(this.dataDir, filename);
    }

    /**
     * Read JSON file
     */
    read<D = T>(filename: string, defaultValue: D): D {
        const filePath = this.getFilePath(filename);

        // Check cache
        if (this.cache.has(filename)) {
            return this.cache.get(filename) as unknown as D;
        }

        try {
            if (existsSync(filePath)) {
                const content = readFileSync(filePath, "utf-8");
                const data = JSON.parse(content) as D;
                this.cache.set(filename, data as unknown as T);
                return data;
            }
        } catch (error) {
            console.error(`[storage] Failed to read ${filename}:`, error);
        }

        return defaultValue;
    }

    /**
     * Write JSON file
     */
    write<D = T>(filename: string, data: D): boolean {
        const filePath = this.getFilePath(filename);

        try {
            // Auto backup
            if (this.autoBackup && existsSync(filePath)) {
                const backupPath = `${filePath}.backup`;
                copyFileSync(filePath, backupPath);
            }

            // Ensure directory exists
            const dir = dirname(filePath);
            if (!existsSync(dir)) {
                mkdirSync(dir, { recursive: true });
            }

            // Write file
            writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");

            // Update cache
            this.cache.set(filename, data as unknown as T);

            return true;
        } catch (error) {
            console.error(`[storage] Failed to write ${filename}:`, error);
            return false;
        }
    }

    /**
     * Invalidate cache
     */
    invalidateCache(filename?: string): void {
        if (filename) {
            this.cache.delete(filename);
        } else {
            this.cache.clear();
        }
    }

    /**
     * Check if file exists
     */
    exists(filename: string): boolean {
        return existsSync(this.getFilePath(filename));
    }
}

/**
 * Create project-specific storage instance
 */
export function createProjectStorage(projectDir: string): LocalStorage<unknown> {
    const dataDir = join(projectDir, ".opencode", "code-buddy", "data");
    return new LocalStorage({ dataDir, autoBackup: true });
}
