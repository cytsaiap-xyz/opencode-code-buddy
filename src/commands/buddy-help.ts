/**
 * Buddy Help Command
 * 
 * Display help for all buddy commands.
 */

/**
 * Command information
 */
interface CommandInfo {
    name: string;
    description: string;
    usage: string;
    examples: string[];
    category: string;
}

/**
 * Command categories
 */
const CATEGORIES = {
    core: "🎯 Core Commands",
    memory: "🧠 Memory System",
    knowledge: "🔗 Knowledge Graph",
    mistakes: "📝 Error Learning",
    workflow: "📋 Workflow",
    ai: "🤖 AI Configuration",
    help: "❓ Help"
};

/**
 * All command definitions
 */
const COMMANDS: CommandInfo[] = [
    // Core Commands
    {
        name: "buddy_do",
        description: "Execute a development task with automatic analysis and recording",
        usage: "buddy_do(task: string)",
        examples: [
            'buddy_do("Implement user login feature")',
            'buddy_do("Fix shopping cart calculation bug")',
            'buddy_do("Refactor API layer")'
        ],
        category: "core"
    },

    // Memory System
    {
        name: "buddy_remember",
        description: "Query project memory and knowledge graph",
        usage: "buddy_remember(query: string, limit?: number, type?: string)",
        examples: [
            'buddy_remember("authentication")',
            'buddy_remember("database", 10)',
            'buddy_remember("login", 5, "decision")'
        ],
        category: "memory"
    },
    {
        name: "buddy_remember_recent",
        description: "Get recent memories",
        usage: "buddy_remember_recent(limit?: number)",
        examples: [
            "buddy_remember_recent()",
            "buddy_remember_recent(10)"
        ],
        category: "memory"
    },
    {
        name: "buddy_remember_stats",
        description: "Get memory and knowledge graph statistics",
        usage: "buddy_remember_stats()",
        examples: [
            "buddy_remember_stats()"
        ],
        category: "memory"
    },
    {
        name: "buddy_add_memory",
        description: "Manually add a project memory",
        usage: "buddy_add_memory(title: string, content: string, type: string, tags?: string[])",
        examples: [
            'buddy_add_memory("Use JWT", "Using RS256 algorithm", "decision", ["auth"])',
            'buddy_add_memory("User login", "Completed login feature", "feature", ["auth", "user"])'
        ],
        category: "memory"
    },

    // Knowledge Graph
    {
        name: "buddy_create_entity",
        description: "Create a knowledge entity",
        usage: "buddy_create_entity(name: string, type: string, observations: string[], tags?: string[])",
        examples: [
            'buddy_create_entity("JWT Auth", "feature", ["Uses RS256", "15min expiry"], ["auth"])',
            'buddy_create_entity("UserService", "component", ["Handles user operations"], ["service"])'
        ],
        category: "knowledge"
    },
    {
        name: "buddy_search_entities",
        description: "Search knowledge graph entities",
        usage: "buddy_search_entities(query: string, limit?: number)",
        examples: [
            'buddy_search_entities("authentication")',
            'buddy_search_entities("user", 5)'
        ],
        category: "knowledge"
    },
    {
        name: "buddy_create_relation",
        description: "Create a relationship between two entities",
        usage: "buddy_create_relation(from: string, to: string, type: string, description?: string)",
        examples: [
            'buddy_create_relation("JWT Auth", "User System", "depends_on")',
            'buddy_create_relation("AuthService", "UserService", "uses", "For user authentication")'
        ],
        category: "knowledge"
    },

    // Error Learning
    {
        name: "buddy_record_mistake",
        description: "Record an AI mistake for learning and prevention",
        usage: "buddy_record_mistake(action: string, errorType: string, userCorrection: string, correctMethod: string, impact: string, preventionMethod: string, relatedRule?: string)",
        examples: [
            'buddy_record_mistake("Edited without reading file", "procedure-violation", "Must read first", "Read before edit", "Broke formatting", "Always read before editing")'
        ],
        category: "mistakes"
    },
    {
        name: "buddy_get_mistake_patterns",
        description: "Get error pattern analysis and prevention summary",
        usage: "buddy_get_mistake_patterns()",
        examples: [
            "buddy_get_mistake_patterns()"
        ],
        category: "mistakes"
    },

    // Workflow
    {
        name: "buddy_get_workflow_guidance",
        description: "Get workflow guidance for current development phase",
        usage: "buddy_get_workflow_guidance(phase: string, filesChanged?: string[], testsPassing?: boolean, hasLintErrors?: boolean)",
        examples: [
            'buddy_get_workflow_guidance("implementing")',
            'buddy_get_workflow_guidance("code-written", ["src/auth.ts"], true)',
            'buddy_get_workflow_guidance("testing", [], false, true)'
        ],
        category: "workflow"
    },
    {
        name: "buddy_get_session_health",
        description: "Check current work session health",
        usage: "buddy_get_session_health()",
        examples: [
            "buddy_get_session_health()"
        ],
        category: "workflow"
    },

    // AI Configuration
    {
        name: "buddy_configure_ai",
        description: "Configure vLLM OpenAI Compatible API (optional, works offline without AI)",
        usage: "buddy_configure_ai(baseUrl: string, model: string, apiKey?: string, enabled?: boolean)",
        examples: [
            'buddy_configure_ai("http://localhost:8000/v1", "qwen2.5-coder-7b")',
            'buddy_configure_ai("http://localhost:11434/v1", "codellama", "", true)'
        ],
        category: "ai"
    },
    {
        name: "buddy_test_ai_connection",
        description: "Test vLLM API connection",
        usage: "buddy_test_ai_connection()",
        examples: [
            "buddy_test_ai_connection()"
        ],
        category: "ai"
    },
    {
        name: "buddy_get_ai_status",
        description: "Get vLLM AI configuration status",
        usage: "buddy_get_ai_status()",
        examples: [
            "buddy_get_ai_status()"
        ],
        category: "ai"
    },

    // Help
    {
        name: "buddy_help",
        description: "Display help for all buddy commands",
        usage: "buddy_help(command?: string)",
        examples: [
            "buddy_help()",
            'buddy_help("buddy_do")'
        ],
        category: "help"
    }
];

/**
 * Buddy Help Command Handler
 */
export class BuddyHelpCommand {
    /**
     * Get help
     */
    getHelp(command?: string): string {
        if (command) {
            return this.getCommandHelp(command);
        }
        return this.getAllHelp();
    }

    /**
     * Get help for a specific command
     */
    private getCommandHelp(commandName: string): string {
        const cmd = COMMANDS.find(c =>
            c.name === commandName || c.name === `buddy_${commandName}`
        );

        if (!cmd) {
            return `❌ Command "${commandName}" not found.

Use \`buddy_help()\` to see all available commands.`;
        }

        const examples = cmd.examples.map(e => `\`\`\`\n${e}\n\`\`\``).join("\n");

        return `## ${CATEGORIES[cmd.category as keyof typeof CATEGORIES]} ${cmd.name}

**Description**: ${cmd.description}

**Usage**:
\`\`\`
${cmd.usage}
\`\`\`

**Examples**:
${examples}`;
    }

    /**
     * Get all commands help
     */
    private getAllHelp(): string {
        let message = `# 🤖 Code Buddy Help

> AI Development Assistant Plugin - Fully Offline

---

`;

        // Group commands by category
        const grouped: Record<string, CommandInfo[]> = {};
        for (const cmd of COMMANDS) {
            if (!grouped[cmd.category]) {
                grouped[cmd.category] = [];
            }
            grouped[cmd.category].push(cmd);
        }

        // Format each category
        for (const [category, commands] of Object.entries(grouped)) {
            const categoryName = CATEGORIES[category as keyof typeof CATEGORIES] || category;
            message += `## ${categoryName}\n\n`;

            for (const cmd of commands) {
                message += `### \`${cmd.name}\`
${cmd.description}
\`\`\`
${cmd.usage}
\`\`\`

`;
            }
        }

        message += `---

💡 Use \`buddy_help("command_name")\` to get detailed help for a specific command.

📴 All core features work **offline**. AI enhancement is optional.`;

        return message;
    }
}
