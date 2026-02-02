/**
 * Workflow Guidance System
 * 
 * Provides development workflow guidance and next step suggestions.
 */

/**
 * Workflow phases
 */
export type WorkflowPhase =
    | "idle"           // Idle
    | "planning"       // Planning
    | "implementing"   // Implementing
    | "code-written"   // Code written
    | "testing"        // Testing
    | "test-complete"  // Test complete
    | "reviewing"      // Reviewing
    | "commit-ready"   // Ready to commit
    | "committed"      // Committed
    | "deploying"      // Deploying
    | "completed";     // Completed

/**
 * Workflow guidance result
 */
export interface WorkflowGuidance {
    currentPhase: WorkflowPhase;
    nextSteps: string[];
    warnings: string[];
    recommendations: string[];
    completeness: number;  // 0-100
}

/**
 * Workflow Guidance Manager
 */
export class WorkflowGuidanceManager {
    /**
     * Get workflow guidance
     */
    getGuidance(
        phase: WorkflowPhase,
        context: {
            filesChanged?: string[];
            testsPassing?: boolean;
            hasLintErrors?: boolean;
            hasTodos?: boolean;
        } = {}
    ): WorkflowGuidance {
        const { filesChanged = [], testsPassing, hasLintErrors, hasTodos } = context;

        const nextSteps = this.getNextSteps(phase);
        const warnings = this.getWarnings(phase, context);
        const recommendations = this.getRecommendations(phase, context);
        const completeness = this.calculateCompleteness(phase);

        return {
            currentPhase: phase,
            nextSteps,
            warnings,
            recommendations,
            completeness
        };
    }

    /**
     * Get next steps
     */
    private getNextSteps(phase: WorkflowPhase): string[] {
        const steps: Record<WorkflowPhase, string[]> = {
            "idle": [
                "📋 Define clear task goals",
                "🔍 Research existing code",
                "📝 Create implementation plan"
            ],
            "planning": [
                "📐 Design interfaces and data structures",
                "🏗️ Confirm architecture direction",
                "✅ List acceptance criteria"
            ],
            "implementing": [
                "💻 Write core logic",
                "📝 Add necessary comments",
                "🧪 Write unit tests"
            ],
            "code-written": [
                "🧪 Run tests to verify functionality",
                "🔍 Check for lint errors",
                "📖 Update documentation"
            ],
            "testing": [
                "✅ Ensure all tests pass",
                "🔄 Fix failing tests",
                "📊 Check test coverage"
            ],
            "test-complete": [
                "👀 Self-review code",
                "📝 Verify code style compliance",
                "🔗 Check dependencies"
            ],
            "reviewing": [
                "💬 Address review feedback",
                "🔧 Make necessary changes",
                "✅ Wait for approval"
            ],
            "commit-ready": [
                "📝 Write clear commit message",
                "🔄 Ensure branch is up to date",
                "✅ Commit changes"
            ],
            "committed": [
                "🔀 Create Pull Request",
                "📋 Fill in PR description",
                "👥 Request team review"
            ],
            "deploying": [
                "🚀 Monitor deployment",
                "✅ Verify deployment success",
                "🔍 Check production functionality"
            ],
            "completed": [
                "📚 Document lessons learned",
                "🎉 Celebrate completion!",
                "📋 Start next task"
            ]
        };

        return steps[phase] || steps["idle"];
    }

    /**
     * Get warnings
     */
    private getWarnings(
        phase: WorkflowPhase,
        context: {
            filesChanged?: string[];
            testsPassing?: boolean;
            hasLintErrors?: boolean;
            hasTodos?: boolean;
        }
    ): string[] {
        const warnings: string[] = [];

        if (context.hasLintErrors) {
            warnings.push("⚠️ Lint errors need to be fixed");
        }

        if (context.testsPassing === false) {
            warnings.push("❌ Tests are failing, please fix first");
        }

        if (context.hasTodos) {
            warnings.push("📝 TODOs in code need attention");
        }

        if (phase === "commit-ready" && context.testsPassing !== true) {
            warnings.push("⚠️ Please verify all tests pass before committing");
        }

        if (phase === "deploying" && context.testsPassing !== true) {
            warnings.push("🚨 Not recommended to deploy with failing tests");
        }

        return warnings;
    }

    /**
     * Get recommendations
     */
    private getRecommendations(
        phase: WorkflowPhase,
        context: {
            filesChanged?: string[];
            testsPassing?: boolean;
            hasLintErrors?: boolean;
            hasTodos?: boolean;
        }
    ): string[] {
        const recommendations: string[] = [];
        const { filesChanged = [] } = context;

        // Recommendations based on changed files
        if (filesChanged.length > 5) {
            recommendations.push("💡 Many files changed, consider splitting into smaller commits");
        }

        if (filesChanged.some(f => f.includes("test"))) {
            recommendations.push("🧪 Don't forget to run tests to verify nothing is broken");
        }

        if (filesChanged.some(f => f.includes("config") || f.includes("package.json"))) {
            recommendations.push("⚙️ Config files changed, please review carefully");
        }

        // Phase-specific recommendations
        if (phase === "implementing") {
            recommendations.push("💡 Writing tests alongside code is more efficient");
        }

        if (phase === "code-written") {
            recommendations.push("💡 Use buddy_do to record completed work");
        }

        if (phase === "completed") {
            recommendations.push("💡 Use buddy_remember to recall this experience later");
        }

        return recommendations;
    }

    /**
     * Calculate completeness
     */
    private calculateCompleteness(phase: WorkflowPhase): number {
        const completeness: Record<WorkflowPhase, number> = {
            "idle": 0,
            "planning": 10,
            "implementing": 30,
            "code-written": 50,
            "testing": 60,
            "test-complete": 70,
            "reviewing": 80,
            "commit-ready": 90,
            "committed": 95,
            "deploying": 98,
            "completed": 100
        };

        return completeness[phase] ?? 0;
    }

    /**
     * Format guidance result
     */
    formatGuidance(guidance: WorkflowGuidance): string {
        const phaseEmoji: Record<WorkflowPhase, string> = {
            "idle": "💤",
            "planning": "📋",
            "implementing": "💻",
            "code-written": "✍️",
            "testing": "🧪",
            "test-complete": "✅",
            "reviewing": "👀",
            "commit-ready": "📦",
            "committed": "📤",
            "deploying": "🚀",
            "completed": "🎉"
        };

        const progressBar = "█".repeat(Math.round(guidance.completeness / 10)) +
            "░".repeat(10 - Math.round(guidance.completeness / 10));

        let message = `## ${phaseEmoji[guidance.currentPhase]} Workflow Guidance\n\n`;
        message += `**Current Phase**: ${guidance.currentPhase}\n`;
        message += `**Progress**: ${progressBar} ${guidance.completeness}%\n\n`;

        if (guidance.warnings.length > 0) {
            message += `### ⚠️ Warnings\n`;
            for (const warning of guidance.warnings) {
                message += `${warning}\n`;
            }
            message += "\n";
        }

        message += `### 📋 Next Steps\n`;
        for (const step of guidance.nextSteps) {
            message += `${step}\n`;
        }

        if (guidance.recommendations.length > 0) {
            message += `\n### 💡 Recommendations\n`;
            for (const rec of guidance.recommendations) {
                message += `${rec}\n`;
            }
        }

        return message;
    }
}
