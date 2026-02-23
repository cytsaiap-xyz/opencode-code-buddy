/**
 * JSON file-based persistent storage.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export class LocalStorage {
    private baseDir: string;

    constructor(dataDir: string) {
        this.baseDir = dataDir;
        this.ensureDir();
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
            console.log(`[code-buddy] Error reading ${filename}:`, error);
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
            console.log(`[code-buddy] Error writing ${filename}:`, error);
            return false;
        }
    }
}
