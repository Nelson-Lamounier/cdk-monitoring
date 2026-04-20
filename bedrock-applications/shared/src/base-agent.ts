/**
 * @format
 * Base Agent — Abstract Class for Single-Turn Bedrock Pipeline Agents
 *
 * Provides a standardised lifecycle for all agents that use the
 * Bedrock Converse API via `runAgent()`. Subclasses implement
 * three abstract methods:
 *
 * - `getConfig(input, ctx)` → Agent configuration (model, tokens, thinking budget)
 * - `buildUserMessage(input, ctx)` → Convert typed input into a prompt string
 * - `parseResponse(text, input, ctx)` → Parse raw LLM text into the typed output
 *
 * All three methods receive `input` and `ctx` for maximum flexibility:
 * - `getConfig` can derive dynamic thinking budgets from the input
 * - `parseResponse` can use context flags (e.g. `includeCoverLetter`)
 *
 * The base class handles:
 * - Configuration assembly
 * - `runAgent<T>()` orchestration
 * - Optional lifecycle hooks (`beforeExecute`, `afterExecute`)
 * - Structured logging around execution
 *
 * Excluded agents (by design):
 * - **Self-healing** — multi-turn conversation loop with MCP tool use
 * - **Chatbot** — uses `InvokeAgentCommand`, not `ConverseCommand`
 *
 * @example
 * ```typescript
 * class WriterAgent extends BaseAgent<WriterInput, WriterResult, PipelineContext> {
 *   protected readonly agentName = 'writer' as const;
 *
 *   protected getConfig(input: WriterInput): AgentConfig { ... }
 *   protected buildUserMessage(input: WriterInput, ctx: PipelineContext): string { ... }
 *   protected parseResponse(text: string): WriterResult { ... }
 * }
 *
 * const agent = new WriterAgent();
 * const result = await agent.execute(input, ctx);
 * ```
 */

import { runAgent } from './agent-runner.js';
import { log } from './logger.js';
import type { AgentConfig, AgentResult } from './types.js';

// =============================================================================
// PIPELINE CONTEXT CONSTRAINT
// =============================================================================

/**
 * Minimal pipeline context shape required by `BaseAgent`.
 *
 * Both `PipelineContext` (article pipeline) and `StrategistPipelineContext`
 * (job-strategist pipeline) satisfy this constraint, enabling a single
 * base class to serve both pipelines without coupling to either.
 */
export interface BasePipelineContext {
    /** Unique pipeline execution ID */
    readonly pipelineId: string;

    /** Runtime environment (e.g. 'development', 'production') */
    readonly environment: string;

    /** Cumulative token usage across all agents */
    cumulativeTokens: {
        input: number;
        output: number;
        thinking: number;
    };

    /** Cumulative estimated cost in USD */
    cumulativeCostUsd: number;
}

// =============================================================================
// BASE AGENT ABSTRACT CLASS
// =============================================================================

/**
 * Abstract base class for all single-turn Bedrock pipeline agents.
 *
 * Encapsulates the common execution lifecycle:
 * 1. Build configuration via {@link getConfig}
 * 2. Build user message via {@link buildUserMessage}
 * 3. Execute via shared `runAgent<T>()`
 * 4. Emit structured logs before/after execution
 *
 * All three abstract methods receive `input` and `ctx` so that
 * subclasses can derive dynamic values (e.g. thinking budget from
 * input complexity, cover letter flags from pipeline context).
 * Subclasses that don't need these parameters may ignore them.
 *
 * @template TInput  - The typed input the agent receives
 * @template TOutput - The typed output the agent produces
 * @template TCtx    - Pipeline context type (defaults to {@link BasePipelineContext})
 */
export abstract class BaseAgent<
    TInput,
    TOutput,
    TCtx extends BasePipelineContext = BasePipelineContext,
> {
    // ─── Abstract Members ────────────────────────────────────────────────────

    /**
     * Agent name identifier for logging, metrics, and tracing.
     * Must match a valid `AgentName` value.
     */
    protected abstract readonly agentName: string;

    /**
     * Build the agent configuration.
     *
     * Called once per execution. Subclasses read environment variables
     * and return a fully populated {@link AgentConfig} object.
     *
     * Receives `input` and `ctx` for dynamic configuration — e.g.
     * the Writer Agent derives its thinking budget from the research
     * complexity tier in the input.
     *
     * @param input - Typed agent input (for dynamic config)
     * @param ctx   - Pipeline context (for environment-specific config)
     * @returns Model-agnostic agent configuration
     */
    protected abstract getConfig(input: TInput, ctx: TCtx): AgentConfig;

    /**
     * Convert the typed input into a user message string for the LLM.
     *
     * @param input - Typed agent input
     * @param ctx   - Pipeline context for correlation data
     * @returns User message string to send to Bedrock
     */
    protected abstract buildUserMessage(input: TInput, ctx: TCtx): string;

    /**
     * Parse the raw LLM text response into the typed output.
     *
     * Receives `input` and `ctx` for cases where parsing depends
     * on context — e.g. the Strategist Agent uses `ctx.includeCoverLetter`
     * to decide whether to extract the cover letter section.
     *
     * Subclasses that don't need these parameters may ignore them.
     *
     * @param responseText - Concatenated text blocks from Bedrock's response
     * @param input - Original typed input (for context-dependent parsing)
     * @param ctx   - Pipeline context (for context-dependent parsing)
     * @returns Parsed, typed agent output
     * @throws Error if the response cannot be parsed or validated
     */
    protected abstract parseResponse(responseText: string, input: TInput, ctx: TCtx): TOutput;

    // ─── Optional Lifecycle Hooks ────────────────────────────────────────────

    /**
     * Optional hook invoked before agent execution.
     *
     * Use for input validation, pre-execution logging, or
     * context enrichment. Throwing here aborts execution.
     *
     * @param input - Typed agent input
     * @param ctx   - Pipeline context
     */
    protected beforeExecute?(input: TInput, ctx: TCtx): void;

    /**
     * Optional hook invoked after successful agent execution.
     *
     * Use for post-execution logging, result sanitisation, or
     * custom metric emission.
     *
     * @param result - The agent's typed result
     * @param input  - Original typed input (for result-context correlation)
     * @param ctx    - Pipeline context (updated with token/cost data)
     */
    protected afterExecute?(result: AgentResult<TOutput>, input: TInput, ctx: TCtx): void;

    // ─── Public Execution Method ─────────────────────────────────────────────

    /**
     * Execute the agent — orchestrates the full lifecycle.
     *
     * 1. Invokes {@link beforeExecute} hook (if defined)
     * 2. Builds config and user message
     * 3. Calls `runAgent<T>()` with the parse function
     * 4. Invokes {@link afterExecute} hook (if defined)
     * 5. Returns typed {@link AgentResult}
     *
     * @param input - Typed agent input
     * @param ctx   - Pipeline context for token/cost accumulation
     * @returns Typed agent result with execution metadata
     * @throws AgentExecutionError if the Bedrock call fails
     */
    async execute(input: TInput, ctx: TCtx): Promise<AgentResult<TOutput>> {
        this.beforeExecute?.(input, ctx);

        const config = this.getConfig(input, ctx);

        log('INFO', `${this.agentName} executing`, {
            agent: this.agentName,
            pipelineId: ctx.pipelineId,
            modelId: config.modelId,
            thinkingBudget: config.thinkingBudget,
        });

        const result = await runAgent<TOutput>({
            config,
            userMessage: this.buildUserMessage(input, ctx),
            parseResponse: (text) => this.parseResponse(text, input, ctx),
            pipelineContext: ctx,
        });

        this.afterExecute?.(result, input, ctx);

        log('INFO', `${this.agentName} complete`, {
            agent: this.agentName,
            pipelineId: ctx.pipelineId,
            durationMs: result.durationMs,
            costUsd: result.costUsd.toFixed(6),
        });

        return result;
    }
}
