/**
 * Buddy Do Command
 * 
 * Execute development tasks and automatically analyze and record them.
 * Supports AI-enhanced analysis (optional).
 */

import { ProjectMemory, type MemoryType } from "../memory/project-memory.js";
import { KnowledgeGraph, type EntityType } from "../memory/knowledge-graph.js";
import type { VLLMClient } from "../ai/vllm-client.js";

/**
 * Task type
 */
export type TaskType =
    | "implement"    // Implement feature
    | "fix"          // Fix bug
    | "refactor"     // Refactor code
    | "research"     // Research
    | "document"     // Documentation
    | "test"         // Testing
    | "review"       // Code review
    | "deploy"       // Deployment
    | "configure"    // Configuration
    | "other";       // Other

/**
 * Task complexity
 */
export type TaskComplexity = "low" | "medium" | "high";

/**
 * Task execution result
 */
export interface TaskResult {
    success: boolean;
    taskId: string;
    type: TaskType;
    complexity: TaskComplexity;
    steps: string[];
    message: string;
}

/**
 * Buddy Do Command Handler
 */
export class BuddyDoCommand {
    private memory: ProjectMemory;
    private graph: KnowledgeGraph;
    private vllm: VLLMClient | null;

    constructor(
        memory: ProjectMemory,
        graph: KnowledgeGraph,
        vllm?: VLLMClient
    ) {
        this.memory = memory;
        this.graph = graph;
        this.vllm = vllm || null;
    }

    /**
     * Execute task
     */
    async execute(taskDescription: string): Promise<TaskResult> {
        // Analyze task (use AI if enabled)
        let analysis = await this.analyzeTask(taskDescription);

        // Record to memory
        const memoryEntry = this.memory.add({
            type: this.mapTaskTypeToMemoryType(analysis.type),
            title: `Task: ${taskDescription.substring(0, 50)}...`,
            content: `## Task Description\n${taskDescription}\n\n## Analysis\n- Type: ${analysis.type}\n- Complexity: ${analysis.complexity}\n\n## Suggested Steps\n${analysis.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`,
            tags: ["buddy-do", analysis.type, analysis.complexity]
        });

        // Create knowledge entity
        this.graph.createEntity(
            `task_${memoryEntry.id}`,
            "feature",
            [
                `Type: ${analysis.type}`,
                `Complexity: ${analysis.complexity}`,
                taskDescription
            ],
            ["task", analysis.type]
        );

        // Generate response message
        const message = this.formatResult(taskDescription, analysis, memoryEntry.id);

        return {
            success: true,
            taskId: memoryEntry.id,
            type: analysis.type,
            complexity: analysis.complexity,
            steps: analysis.steps,
            message
        };
    }

    /**
     * Analyze task
     */
    private async analyzeTask(description: string): Promise<{
        type: TaskType;
        complexity: TaskComplexity;
        steps: string[];
    }> {
        // Try AI analysis first
        if (this.vllm?.isEnabled()) {
            try {
                const result = await this.vllm.analyzeTask(description);
                if (result.success && result.analysis) {
                    return {
                        type: this.normalizeTaskType(result.analysis.type),
                        complexity: this.normalizeComplexity(result.analysis.complexity),
                        steps: result.analysis.steps
                    };
                }
            } catch (error) {
                console.log("[buddy-do] AI analysis failed, fallback to pattern matching");
            }
        }

        // Fallback: Use pattern matching
        return this.analyzeTaskLocally(description);
    }

    /**
     * Local task analysis (pattern matching)
     */
    private analyzeTaskLocally(description: string): {
        type: TaskType;
        complexity: TaskComplexity;
        steps: string[];
    } {
        const lowerDesc = description.toLowerCase();

        // Determine task type
        let type: TaskType = "other";

        if (/implement|build|create|add|develop|feature/.test(lowerDesc)) {
            type = "implement";
        } else if (/fix|bug|error|issue|problem|resolve/.test(lowerDesc)) {
            type = "fix";
        } else if (/refactor|improve|optimize|clean|restructure/.test(lowerDesc)) {
            type = "refactor";
        } else if (/research|investigate|analyze|study|explore/.test(lowerDesc)) {
            type = "research";
        } else if (/document|docs|readme|comment|jsdoc/.test(lowerDesc)) {
            type = "document";
        } else if (/test|spec|unit|integration|e2e/.test(lowerDesc)) {
            type = "test";
        } else if (/review|check|audit|inspect/.test(lowerDesc)) {
            type = "review";
        } else if (/deploy|release|publish|ship/.test(lowerDesc)) {
            type = "deploy";
        } else if (/config|setup|install|configure/.test(lowerDesc)) {
            type = "configure";
        }

        // Estimate complexity
        let complexity: TaskComplexity = "medium";
        const wordCount = description.split(/\s+/).length;

        if (wordCount < 10 || /simple|easy|quick|small/.test(lowerDesc)) {
            complexity = "low";
        } else if (wordCount > 30 || /complex|difficult|large|system/.test(lowerDesc)) {
            complexity = "high";
        }

        // Generate suggested steps
        const steps = this.generateSteps(type, complexity);

        return { type, complexity, steps };
    }

    /**
     * Generate suggested steps
     */
    private generateSteps(type: TaskType, complexity: TaskComplexity): string[] {
        const baseSteps: Record<TaskType, string[]> = {
            implement: [
                "Understand requirements and acceptance criteria",
                "Design data structures and interfaces",
                "Implement core functionality",
                "Write unit tests",
                "Integration and testing"
            ],
            fix: [
                "Reproduce the issue",
                "Analyze error messages and logs",
                "Identify root cause",
                "Implement fix",
                "Verify fix and add regression test"
            ],
            refactor: [
                "Review existing code",
                "Identify refactoring targets",
                "Perform incremental changes",
                "Ensure tests pass",
                "Code review"
            ],
            research: [
                "Define scope of research",
                "Gather relevant materials",
                "Analyze and compare options",
                "Document findings",
                "Provide recommendations"
            ],
            document: [
                "Identify documentation audience",
                "Outline structure",
                "Write draft content",
                "Add code examples",
                "Review and finalize"
            ],
            test: [
                "Identify test scenarios",
                "Set up test environment",
                "Write test cases",
                "Run tests and validate",
                "Report results"
            ],
            review: [
                "Review code diff",
                "Check code style compliance",
                "Verify business logic",
                "Confirm test coverage",
                "Provide feedback"
            ],
            deploy: [
                "Confirm deployment requirements",
                "Back up if necessary",
                "Execute deployment",
                "Verify deployment success",
                "Monitor for issues"
            ],
            configure: [
                "Understand configuration goals",
                "Choose appropriate settings",
                "Update configuration files",
                "Test changes",
                "Document configuration"
            ],
            other: [
                "Clarify task goals",
                "Create action plan",
                "Execute step by step",
                "Verify results",
                "Document outcomes"
            ]
        };

        let steps = [...baseSteps[type]];

        // Add complexity-specific steps
        if (complexity === "high") {
            steps = [
                "Break down task into smaller parts",
                ...steps,
                "Conduct comprehensive testing"
            ];
        }

        return steps;
    }

    /**
     * Normalize task type
     */
    private normalizeTaskType(type: string): TaskType {
        const typeMap: Record<string, TaskType> = {
            implement: "implement",
            fix: "fix",
            refactor: "refactor",
            research: "research",
            document: "document",
            test: "test",
            review: "review",
            deploy: "deploy",
            configure: "configure"
        };
        return typeMap[type.toLowerCase()] || "other";
    }

    /**
     * Normalize complexity
     */
    private normalizeComplexity(c: string): TaskComplexity {
        const cLower = c.toLowerCase();
        if (cLower === "low" || cLower === "simple") return "low";
        if (cLower === "high" || cLower === "complex") return "high";
        return "medium";
    }

    /**
     * Map task type to memory type
     */
    private mapTaskTypeToMemoryType(type: TaskType): MemoryType {
        const mapping: Record<TaskType, MemoryType> = {
            implement: "feature",
            fix: "bugfix",
            refactor: "pattern",
            research: "note",
            document: "note",
            test: "note",
            review: "note",
            deploy: "note",
            configure: "note",
            other: "note"
        };
        return mapping[type];
    }

    /**
     * Format result message
     */
    private formatResult(
        description: string,
        analysis: { type: TaskType; complexity: TaskComplexity; steps: string[] },
        taskId: string
    ): string {
        const typeEmoji: Record<TaskType, string> = {
            implement: "🔨",
            fix: "🔧",
            refactor: "♻️",
            research: "🔍",
            document: "📝",
            test: "🧪",
            review: "👀",
            deploy: "🚀",
            configure: "⚙️",
            other: "📋"
        };

        const complexityEmoji: Record<TaskComplexity, string> = {
            low: "🟢",
            medium: "🟡",
            high: "🔴"
        };

        const stepsFormatted = analysis.steps
            .map((step, i) => `${i + 1}. ${step}`)
            .join("\n");

        return `## ${typeEmoji[analysis.type]} Task Received

**Task**: ${description}

---

### 📊 Task Analysis
- **Type**: ${analysis.type}
- **Complexity**: ${complexityEmoji[analysis.complexity]} ${analysis.complexity}
- **Task ID**: ${taskId}

---

### 📋 Suggested Steps
${stepsFormatted}

---

💾 This task has been recorded in project memory. Use \`buddy_remember\` to recall it later.`;
    }
}
