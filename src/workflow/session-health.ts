/**
 * Session Health Monitor
 * 
 * Monitor work session health status.
 */

import { LocalStorage, createProjectStorage } from "../utils/storage.js";

/**
 * Session state
 */
export interface SessionState {
    sessionId: string;
    startTime: number;
    lastActivity: number;
    tasksCompleted: number;
    memoriesCreated: number;
    errorsRecorded: number;
    currentPhase: string;
}

/**
 * Session health report
 */
export interface SessionHealthReport {
    sessionId: string;
    duration: number;  // milliseconds
    durationFormatted: string;
    isHealthy: boolean;
    metrics: {
        tasksCompleted: number;
        memoriesCreated: number;
        errorsRecorded: number;
        productivity: number;  // 0-100
    };
    warnings: string[];
    suggestions: string[];
}

/**
 * Sessions data structure
 */
interface SessionsData {
    version: number;
    currentSession: SessionState | null;
    history: SessionState[];
    lastUpdated: number;
}

const SESSIONS_FILE = "sessions.json";
const CURRENT_VERSION = 1;

/**
 * Session Health Monitor
 */
export class SessionHealthMonitor {
    private storage: LocalStorage<unknown>;
    private data: SessionsData;

    constructor(projectDir: string) {
        this.storage = createProjectStorage(projectDir);
        this.data = this.load();
    }

    /**
     * Load sessions data
     */
    private load(): SessionsData {
        const defaultData: SessionsData = {
            version: CURRENT_VERSION,
            currentSession: null,
            history: [],
            lastUpdated: Date.now()
        };

        return this.storage.read<SessionsData>(SESSIONS_FILE, defaultData);
    }

    /**
     * Save sessions data
     */
    private save(): boolean {
        this.data.lastUpdated = Date.now();
        return this.storage.write(SESSIONS_FILE, this.data);
    }

    /**
     * Start new session
     */
    startSession(): SessionState {
        // End old session
        if (this.data.currentSession) {
            this.data.history.push(this.data.currentSession);
            // Keep only last 50 sessions
            if (this.data.history.length > 50) {
                this.data.history = this.data.history.slice(-50);
            }
        }

        const session: SessionState = {
            sessionId: `session_${Date.now()}`,
            startTime: Date.now(),
            lastActivity: Date.now(),
            tasksCompleted: 0,
            memoriesCreated: 0,
            errorsRecorded: 0,
            currentPhase: "idle"
        };

        this.data.currentSession = session;
        this.save();

        return session;
    }

    /**
     * Update session activity
     */
    updateActivity(updates?: Partial<SessionState>): void {
        if (!this.data.currentSession) {
            this.startSession();
        }

        if (this.data.currentSession) {
            this.data.currentSession.lastActivity = Date.now();

            if (updates) {
                Object.assign(this.data.currentSession, updates);
            }

            this.save();
        }
    }

    /**
     * Increment tasks completed
     */
    incrementTasksCompleted(): void {
        if (this.data.currentSession) {
            this.data.currentSession.tasksCompleted++;
            this.data.currentSession.lastActivity = Date.now();
            this.save();
        }
    }

    /**
     * Increment memories created
     */
    incrementMemoriesCreated(): void {
        if (this.data.currentSession) {
            this.data.currentSession.memoriesCreated++;
            this.data.currentSession.lastActivity = Date.now();
            this.save();
        }
    }

    /**
     * Increment errors recorded
     */
    incrementErrorsRecorded(): void {
        if (this.data.currentSession) {
            this.data.currentSession.errorsRecorded++;
            this.data.currentSession.lastActivity = Date.now();
            this.save();
        }
    }

    /**
     * Get current session
     */
    getCurrentSession(): SessionState | null {
        return this.data.currentSession;
    }

    /**
     * Get session health report
     */
    getHealthReport(): SessionHealthReport {
        let session = this.data.currentSession;

        if (!session) {
            session = this.startSession();
        }

        const now = Date.now();
        const duration = now - session.startTime;
        const durationFormatted = this.formatDuration(duration);

        const warnings: string[] = [];
        const suggestions: string[] = [];

        // Check session duration
        const hours = duration / (1000 * 60 * 60);
        if (hours > 4) {
            warnings.push("⚠️ Working for over 4 hours, consider taking a break");
        }
        if (hours > 2 && session.tasksCompleted === 0) {
            warnings.push("💭 Working for 2 hours without completing a task, are you stuck?");
        }

        // Check error rate
        if (session.errorsRecorded > 3) {
            warnings.push("📝 Multiple errors recorded, check error pattern analysis");
        }

        // Calculate productivity score
        const productivity = this.calculateProductivity(session, duration);

        // Suggestions
        if (session.memoriesCreated === 0 && session.tasksCompleted > 0) {
            suggestions.push("💡 Try using buddy_remember to record important decisions");
        }
        if (productivity < 30) {
            suggestions.push("💡 Consider breaking down tasks into smaller steps");
        }
        if (hours > 1 && session.tasksCompleted > 0) {
            suggestions.push("💡 Celebrate each milestone you complete! 🎉");
        }

        const isHealthy = warnings.length === 0 && productivity > 30;

        return {
            sessionId: session.sessionId,
            duration,
            durationFormatted,
            isHealthy,
            metrics: {
                tasksCompleted: session.tasksCompleted,
                memoriesCreated: session.memoriesCreated,
                errorsRecorded: session.errorsRecorded,
                productivity
            },
            warnings,
            suggestions
        };
    }

    /**
     * Calculate productivity score
     */
    private calculateProductivity(session: SessionState, duration: number): number {
        const hours = Math.max(duration / (1000 * 60 * 60), 0.1);

        // Calculate based on tasks and memories per hour
        const tasksPerHour = session.tasksCompleted / hours;
        const memoriesPerHour = session.memoriesCreated / hours;

        // Errors reduce productivity score
        const errorPenalty = session.errorsRecorded * 5;

        // Calculate score (0-100)
        let score = Math.min(
            (tasksPerHour * 30) + (memoriesPerHour * 20) + 30,
            100
        );

        score = Math.max(score - errorPenalty, 0);

        return Math.round(score);
    }

    /**
     * Format duration
     */
    private formatDuration(ms: number): string {
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);

        if (hours > 0) {
            const remainingMinutes = minutes % 60;
            return `${hours} hour${hours > 1 ? 's' : ''} ${remainingMinutes} minute${remainingMinutes !== 1 ? 's' : ''}`;
        } else if (minutes > 0) {
            return `${minutes} minute${minutes !== 1 ? 's' : ''}`;
        } else {
            return `${seconds} second${seconds !== 1 ? 's' : ''}`;
        }
    }

    /**
     * Format health report
     */
    formatHealthReport(report: SessionHealthReport): string {
        const healthEmoji = report.isHealthy ? "💚" : "💛";
        const productivityBar = "█".repeat(Math.round(report.metrics.productivity / 10)) +
            "░".repeat(10 - Math.round(report.metrics.productivity / 10));

        let message = `## ${healthEmoji} Session Health Report\n\n`;
        message += `**Session ID**: ${report.sessionId}\n`;
        message += `**Duration**: ${report.durationFormatted}\n`;
        message += `**Status**: ${report.isHealthy ? "Healthy ✅" : "Needs Attention ⚠️"}\n\n`;

        message += `### 📊 Metrics\n`;
        message += `• Tasks Completed: ${report.metrics.tasksCompleted}\n`;
        message += `• Memories Created: ${report.metrics.memoriesCreated}\n`;
        message += `• Errors Recorded: ${report.metrics.errorsRecorded}\n`;
        message += `• Productivity: ${productivityBar} ${report.metrics.productivity}%\n`;

        if (report.warnings.length > 0) {
            message += `\n### ⚠️ Warnings\n`;
            for (const warning of report.warnings) {
                message += `${warning}\n`;
            }
        }

        if (report.suggestions.length > 0) {
            message += `\n### 💡 Suggestions\n`;
            for (const suggestion of report.suggestions) {
                message += `${suggestion}\n`;
            }
        }

        return message;
    }

    /**
     * Get history statistics
     */
    getHistoryStats(): {
        totalSessions: number;
        totalTasks: number;
        totalMemories: number;
        averageProductivity: number;
    } {
        const sessions = [...this.data.history];
        if (this.data.currentSession) {
            sessions.push(this.data.currentSession);
        }

        const totalTasks = sessions.reduce((sum, s) => sum + s.tasksCompleted, 0);
        const totalMemories = sessions.reduce((sum, s) => sum + s.memoriesCreated, 0);

        return {
            totalSessions: sessions.length,
            totalTasks,
            totalMemories,
            averageProductivity: 0  // Can calculate if needed
        };
    }
}
