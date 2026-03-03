/**
 * JSON file-based persistent storage.
 */

import * as fs from "node:fs";
import * as path from "node:path";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LogFn = (...args: any[]) => void;

export class LocalStorage {
    private baseDir: string;
    private log: LogFn;

    constructor(dataDir: string, log: LogFn = console.log) {
        this.baseDir = dataDir;
        this.log = log;
        this.ensureDir();
    }

    getBaseDir(): string {
        return this.baseDir;
    }

    private ensureDir(): void {
        if (!fs.existsSync(this.baseDir)) {
            fs.mkdirSync(this.baseDir, { recursive: true });
        }
    }

    read<T>(filename: string, defaultValue: T): T {
        const filePath = path.join(this.baseDir, filename);
        try {
            if (fs.existsSync(filePath)) {
                return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
            }
        } catch (error) {
            this.log(`[code-buddy] Error reading ${filename}:`, error);
        }
        return defaultValue;
    }

    write<T>(filename: string, data: T): boolean {
        try {
            this.ensureDir();
            fs.writeFileSync(
                path.join(this.baseDir, filename),
                JSON.stringify(data, null, 2),
                "utf-8",
            );
            return true;
        } catch (error) {
            this.log(`[code-buddy] Error writing ${filename}:`, error);
            return false;
        }
    }
}
