/**
 * vLLM OpenAI Compatible API Client
 * 
 * Uses native fetch API to connect to vLLM or any OpenAI-compatible API.
 * This is an optional feature - core functionality works without AI.
 */

import { LocalStorage, createProjectStorage } from "../utils/storage.js";

/**
 * vLLM configuration
 */
export interface VLLMConfig {
    enabled: boolean;
    baseUrl: string;      // e.g., http://localhost:8000/v1
    model: string;        // Model name
    apiKey?: string;      // Optional API Key
    maxTokens?: number;   // Max tokens
    temperature?: number; // Temperature
}

/**
 * Chat message
 */
export interface ChatMessage {
    role: "system" | "user" | "assistant";
    content: string;
}

/**
 * Chat completion response
 */
export interface ChatCompletion {
    id: string;
    choices: {
        index: number;
        message: ChatMessage;
        finish_reason: string;
    }[];
    usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
}

const CONFIG_FILE = "vllm-config.json";

/**
 * vLLM API Client
 */
export class VLLMClient {
    private storage: LocalStorage<unknown>;
    private config: VLLMConfig;

    constructor(projectDir: string) {
        this.storage = createProjectStorage(projectDir);
        this.config = this.loadConfig();
    }

    /**
     * Load configuration
     */
    private loadConfig(): VLLMConfig {
        const defaultConfig: VLLMConfig = {
            enabled: false,
            baseUrl: "http://localhost:8000/v1",
            model: "default",
            maxTokens: 1024,
            temperature: 0.7
        };

        return this.storage.read<VLLMConfig>(CONFIG_FILE, defaultConfig);
    }

    /**
     * Save configuration
     */
    private saveConfig(): boolean {
        return this.storage.write(CONFIG_FILE, this.config);
    }

    /**
     * Configure API
     */
    configure(config: Partial<VLLMConfig>): { success: boolean; message: string } {
        this.config = {
            ...this.config,
            ...config
        };

        const saved = this.saveConfig();

        if (saved) {
            return {
                success: true,
                message: `✅ vLLM configuration updated\n\n` +
                    `**Base URL**: ${this.config.baseUrl}\n` +
                    `**Model**: ${this.config.model}\n` +
                    `**Enabled**: ${this.config.enabled ? "Yes" : "No"}`
            };
        } else {
            return {
                success: false,
                message: "❌ Failed to save configuration"
            };
        }
    }

    /**
     * Get current configuration
     */
    getConfig(): VLLMConfig {
        return { ...this.config };
    }

    /**
     * Check if enabled
     */
    isEnabled(): boolean {
        return this.config.enabled;
    }

    /**
     * Test connection
     */
    async testConnection(): Promise<{ success: boolean; message: string }> {
        if (!this.config.enabled) {
            return {
                success: false,
                message: "⚠️ vLLM is not enabled. Use `buddy_configure_ai` to configure first."
            };
        }

        try {
            const response = await fetch(`${this.config.baseUrl}/models`, {
                method: "GET",
                headers: this.getHeaders()
            });

            if (response.ok) {
                const data = await response.json();
                const models = data.data?.map((m: { id: string }) => m.id) || [];
                return {
                    success: true,
                    message: `✅ Connection successful!\n\n` +
                        `**Available models**: ${models.join(", ") || "Unknown"}`
                };
            } else {
                return {
                    success: false,
                    message: `❌ Connection failed: HTTP ${response.status}`
                };
            }
        } catch (error) {
            return {
                success: false,
                message: `❌ Connection failed: ${error instanceof Error ? error.message : String(error)}`
            };
        }
    }

    /**
     * Send Chat request
     */
    async chat(
        messages: ChatMessage[],
        options?: {
            maxTokens?: number;
            temperature?: number;
        }
    ): Promise<{ success: boolean; content?: string; error?: string; usage?: ChatCompletion["usage"] }> {
        if (!this.config.enabled) {
            return {
                success: false,
                error: "vLLM is not enabled"
            };
        }

        try {
            const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
                method: "POST",
                headers: this.getHeaders(),
                body: JSON.stringify({
                    model: this.config.model,
                    messages,
                    max_tokens: options?.maxTokens ?? this.config.maxTokens,
                    temperature: options?.temperature ?? this.config.temperature
                })
            });

            if (!response.ok) {
                const errorText = await response.text();
                return {
                    success: false,
                    error: `HTTP ${response.status}: ${errorText}`
                };
            }

            const data: ChatCompletion = await response.json();
            const content = data.choices[0]?.message?.content;

            return {
                success: true,
                content,
                usage: data.usage
            };
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }

    /**
     * Simple text generation
     */
    async generate(prompt: string): Promise<{ success: boolean; content?: string; error?: string }> {
        return this.chat([
            { role: "user", content: prompt }
        ]);
    }

    /**
     * Analyze task complexity (AI-enhanced)
     */
    async analyzeTask(taskDescription: string): Promise<{
        success: boolean;
        analysis?: {
            type: string;
            complexity: string;
            steps: string[];
            estimatedTime: string;
        };
        error?: string;
    }> {
        const prompt = `Analyze the following development task and respond in JSON format:

Task: ${taskDescription}

Please respond with the following JSON format:
{
  "type": "implement/fix/refactor/research/document/test/review/deploy/configure",
  "complexity": "low/medium/high",
  "steps": ["Step 1", "Step 2", ...],
  "estimatedTime": "Estimated time"
}

Respond with only JSON, no other text.`;

        const result = await this.generate(prompt);

        if (!result.success) {
            return { success: false, error: result.error };
        }

        try {
            // Try to parse JSON
            const jsonMatch = result.content?.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const analysis = JSON.parse(jsonMatch[0]);
                return { success: true, analysis };
            } else {
                return { success: false, error: "Cannot parse AI response" };
            }
        } catch {
            return { success: false, error: "JSON parsing failed" };
        }
    }

    /**
     * Get request headers
     */
    private getHeaders(): Record<string, string> {
        const headers: Record<string, string> = {
            "Content-Type": "application/json"
        };

        if (this.config.apiKey) {
            headers["Authorization"] = `Bearer ${this.config.apiKey}`;
        }

        return headers;
    }

    /**
     * Format configuration status
     */
    formatStatus(): string {
        if (!this.config.enabled) {
            return `## ⚙️ vLLM Configuration

**Status**: ❌ Not Enabled

vLLM AI enhancement is optional. All core features work fully offline.

To enable AI features, use:
\`\`\`
buddy_configure_ai("http://localhost:8000/v1", "model-name", "", true)
\`\`\``;
        }

        return `## ⚙️ vLLM Configuration

**Status**: ✅ Enabled
**Base URL**: ${this.config.baseUrl}
**Model**: ${this.config.model}
**Max Tokens**: ${this.config.maxTokens}
**Temperature**: ${this.config.temperature}

Use \`buddy_test_ai_connection()\` to test the connection.`;
    }
}
