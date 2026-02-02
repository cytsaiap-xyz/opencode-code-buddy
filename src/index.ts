/**
 * OpenCode Code Buddy Plugin
 * 
 * AI Development Assistant Plugin - Project Memory, Knowledge Graph, Smart Task Execution
 * Fully offline capable, optional vLLM AI enhancement
 */

import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";

// Memory System
import { ProjectMemory, type MemoryType } from "./memory/project-memory.js";
import { KnowledgeGraph, type EntityType } from "./memory/knowledge-graph.js";

// Commands
import { BuddyDoCommand } from "./commands/buddy-do.js";
import { BuddyRememberCommand } from "./commands/buddy-remember.js";
import { BuddyHelpCommand } from "./commands/buddy-help.js";
import { BuddyRecordMistakeCommand, type ErrorType } from "./commands/buddy-record-mistake.js";

// Workflow
import { WorkflowGuidanceManager, type WorkflowPhase } from "./workflow/guidance.js";
import { SessionHealthMonitor } from "./workflow/session-health.js";

// AI (Optional)
import { VLLMClient } from "./ai/vllm-client.js";

/**
 * OpenCode Code Buddy Plugin
 */
export const CodeBuddyPlugin: Plugin = async (ctx) => {
    const { directory } = ctx;

    // Initialize core systems
    const memory = new ProjectMemory(directory);
    const graph = new KnowledgeGraph(directory);
    const vllmClient = new VLLMClient(directory);

    // Initialize command handlers
    const buddyDo = new BuddyDoCommand(memory, graph, vllmClient);
    const buddyRemember = new BuddyRememberCommand(memory, graph);
    const buddyHelp = new BuddyHelpCommand();
    const buddyMistake = new BuddyRecordMistakeCommand(directory);

    // Initialize workflow systems
    const workflowGuidance = new WorkflowGuidanceManager();
    const sessionHealth = new SessionHealthMonitor(directory);

    // Start new session
    sessionHealth.startSession();

    console.log("[code-buddy] Plugin initialized - offline-ready, AI optional");

    return {
        // Event listeners
        event: async ({ event }) => {
            if (event.type === "session.created") {
                sessionHealth.startSession();
                console.log("[code-buddy] New session started");
            }
        },

        // Tools
        tool: {
            // ========================================
            // Core Task Commands
            // ========================================

            /**
             * buddy_do - Execute task
             */
            buddy_do: tool({
                description: "Execute a development task with automatic analysis and recording. Analyzes task type, complexity, and provides execution suggestions.",
                args: {
                    task: tool.schema.string().describe("Task description (e.g., 'Implement user login feature')")
                },
                async execute(args) {
                    const result = await buddyDo.execute(args.task);
                    sessionHealth.incrementTasksCompleted();
                    sessionHealth.incrementMemoriesCreated();
                    return result.message;
                }
            }),

            // ========================================
            // Memory Query Commands
            // ========================================

            /**
             * buddy_remember - Query memories
             */
            buddy_remember: tool({
                description: "Query project memory and knowledge graph to recall past decisions, patterns, and lessons.",
                args: {
                    query: tool.schema.string().describe("Search keywords"),
                    limit: tool.schema.number().optional().describe("Maximum number of results (default: 5)"),
                    type: tool.schema.string().optional().describe("Filter by type: decision, pattern, bugfix, lesson, feature, note")
                },
                async execute(args) {
                    const result = await buddyRemember.query(args.query, {
                        limit: args.limit,
                        type: args.type as MemoryType | undefined
                    });
                    return result.message;
                }
            }),

            /**
             * buddy_remember_recent - Get recent memories
             */
            buddy_remember_recent: tool({
                description: "Get recent memory entries",
                args: {
                    limit: tool.schema.number().optional().describe("Number of results (default: 5)")
                },
                async execute(args) {
                    const result = buddyRemember.getRecent(args.limit);
                    return result.message;
                }
            }),

            /**
             * buddy_remember_stats - Memory statistics
             */
            buddy_remember_stats: tool({
                description: "Get project memory and knowledge graph statistics",
                args: {},
                async execute() {
                    return buddyRemember.getStats();
                }
            }),

            // ========================================
            // Knowledge Graph Commands
            // ========================================

            /**
             * buddy_create_entity - Create knowledge entity
             */
            buddy_create_entity: tool({
                description: "Create a new entity in the knowledge graph to record important project knowledge",
                args: {
                    name: tool.schema.string().describe("Entity name"),
                    type: tool.schema.string().describe("Type: decision, feature, component, file, bug_fix, lesson, pattern, technology"),
                    observations: tool.schema.array(tool.schema.string()).describe("List of observations/facts"),
                    tags: tool.schema.array(tool.schema.string()).optional().describe("List of tags")
                },
                async execute(args) {
                    const entity = graph.createEntity(
                        args.name,
                        args.type as EntityType,
                        args.observations,
                        args.tags
                    );
                    sessionHealth.incrementMemoriesCreated();
                    return `✅ Entity created\n\n${graph.formatEntity(entity)}`;
                }
            }),

            /**
             * buddy_search_entities - Search knowledge entities
             */
            buddy_search_entities: tool({
                description: "Search entities in the knowledge graph",
                args: {
                    query: tool.schema.string().describe("Search keywords"),
                    limit: tool.schema.number().optional().describe("Number of results (default: 10)")
                },
                async execute(args) {
                    const results = graph.searchEntities(args.query, args.limit);
                    return graph.formatSearchResults(results);
                }
            }),

            /**
             * buddy_create_relation - Create entity relation
             */
            buddy_create_relation: tool({
                description: "Create a relationship between two entities in the knowledge graph",
                args: {
                    from: tool.schema.string().describe("Source entity name"),
                    to: tool.schema.string().describe("Target entity name"),
                    type: tool.schema.string().describe("Relation type: depends_on, implements, related_to, caused_by, fixed_by, uses, extends"),
                    description: tool.schema.string().optional().describe("Relation description")
                },
                async execute(args) {
                    const relation = graph.createRelation(
                        args.from,
                        args.to,
                        args.type as "depends_on" | "implements" | "related_to" | "caused_by" | "fixed_by" | "uses" | "extends",
                        args.description
                    );

                    if (relation) {
                        return `✅ Relation created: ${args.from} --[${args.type}]--> ${args.to}`;
                    } else {
                        return `❌ Cannot create relation. Please verify both entities exist.`;
                    }
                }
            }),

            // ========================================
            // Error Learning Commands
            // ========================================

            /**
             * buddy_record_mistake - Record mistake
             */
            buddy_record_mistake: tool({
                description: "Record an AI mistake for learning and prevention. Build error pattern records to avoid repeating mistakes.",
                args: {
                    action: tool.schema.string().describe("The wrong action taken by AI"),
                    errorType: tool.schema.string().describe("Error type: procedure-violation, workflow-skip, assumption-error, validation-skip, responsibility-lack, firefighting, dependency-miss, integration-error, deployment-error"),
                    userCorrection: tool.schema.string().describe("User's correction"),
                    correctMethod: tool.schema.string().describe("The correct approach"),
                    impact: tool.schema.string().describe("Impact of the error"),
                    preventionMethod: tool.schema.string().describe("Prevention method"),
                    relatedRule: tool.schema.string().optional().describe("Related rule")
                },
                async execute(args) {
                    const result = buddyMistake.record({
                        action: args.action,
                        errorType: args.errorType as ErrorType,
                        userCorrection: args.userCorrection,
                        correctMethod: args.correctMethod,
                        impact: args.impact,
                        preventionMethod: args.preventionMethod,
                        relatedRule: args.relatedRule
                    });
                    sessionHealth.incrementErrorsRecorded();
                    return result.message;
                }
            }),

            /**
             * buddy_get_mistake_patterns - Get error patterns
             */
            buddy_get_mistake_patterns: tool({
                description: "Get error pattern analysis and prevention summary",
                args: {},
                async execute() {
                    return buddyMistake.getPreventionSummary();
                }
            }),

            // ========================================
            // Workflow Commands
            // ========================================

            /**
             * buddy_get_workflow_guidance - Workflow guidance
             */
            buddy_get_workflow_guidance: tool({
                description: "Get workflow guidance and next step suggestions for the current development phase",
                args: {
                    phase: tool.schema.string().describe("Current phase: idle, planning, implementing, code-written, testing, test-complete, reviewing, commit-ready, committed, deploying, completed"),
                    filesChanged: tool.schema.array(tool.schema.string()).optional().describe("List of changed files"),
                    testsPassing: tool.schema.boolean().optional().describe("Whether tests are passing"),
                    hasLintErrors: tool.schema.boolean().optional().describe("Whether there are lint errors")
                },
                async execute(args) {
                    const guidance = workflowGuidance.getGuidance(
                        args.phase as WorkflowPhase,
                        {
                            filesChanged: args.filesChanged,
                            testsPassing: args.testsPassing,
                            hasLintErrors: args.hasLintErrors
                        }
                    );
                    sessionHealth.updateActivity({ currentPhase: args.phase });
                    return workflowGuidance.formatGuidance(guidance);
                }
            }),

            /**
             * buddy_get_session_health - Session health check
             */
            buddy_get_session_health: tool({
                description: "Check current work session health status",
                args: {},
                async execute() {
                    const report = sessionHealth.getHealthReport();
                    return sessionHealth.formatHealthReport(report);
                }
            }),

            // ========================================
            // AI Configuration Commands
            // ========================================

            /**
             * buddy_configure_ai - Configure vLLM
             */
            buddy_configure_ai: tool({
                description: "Configure vLLM OpenAI Compatible API connection (optional feature, core functionality works offline)",
                args: {
                    baseUrl: tool.schema.string().describe("API base URL (e.g., http://localhost:8000/v1)"),
                    model: tool.schema.string().describe("Model name"),
                    apiKey: tool.schema.string().optional().describe("API Key (if required)"),
                    enabled: tool.schema.boolean().optional().describe("Whether to enable (default: true)")
                },
                async execute(args) {
                    const result = vllmClient.configure({
                        baseUrl: args.baseUrl,
                        model: args.model,
                        apiKey: args.apiKey,
                        enabled: args.enabled ?? true
                    });
                    return result.message;
                }
            }),

            /**
             * buddy_test_ai_connection - Test AI connection
             */
            buddy_test_ai_connection: tool({
                description: "Test vLLM API connection status",
                args: {},
                async execute() {
                    const result = await vllmClient.testConnection();
                    return result.message;
                }
            }),

            /**
             * buddy_get_ai_status - Get AI status
             */
            buddy_get_ai_status: tool({
                description: "Get vLLM AI configuration status",
                args: {},
                async execute() {
                    return vllmClient.formatStatus();
                }
            }),

            // ========================================
            // Help Commands
            // ========================================

            /**
             * buddy_help - Get help
             */
            buddy_help: tool({
                description: "Display help for all buddy commands",
                args: {
                    command: tool.schema.string().optional().describe("Specific command name (optional)")
                },
                async execute(args) {
                    return buddyHelp.getHelp(args.command);
                }
            }),

            // ========================================
            // Memory Management Tools
            // ========================================

            /**
             * buddy_add_memory - Manually add memory
             */
            buddy_add_memory: tool({
                description: "Manually add a project memory entry",
                args: {
                    title: tool.schema.string().describe("Memory title"),
                    content: tool.schema.string().describe("Memory content"),
                    type: tool.schema.string().describe("Type: decision, pattern, bugfix, lesson, feature, note"),
                    tags: tool.schema.array(tool.schema.string()).optional().describe("List of tags")
                },
                async execute(args) {
                    const entry = memory.add({
                        type: args.type as MemoryType,
                        title: args.title,
                        content: args.content,
                        tags: args.tags || []
                    });
                    sessionHealth.incrementMemoriesCreated();
                    return `✅ Memory added\n\n${memory.formatEntry(entry)}`;
                }
            })
        }
    };
};

export default CodeBuddyPlugin;
