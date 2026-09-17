# ramptoerist-ai

Experimental autonomous AI "agent" that is fully isolated to a single Discord channel.

Uses the [Vercel AI SDK](https://ai-sdk.dev/) with local [Ollama](https://ollama.com/) or [LM Studio](https://lmstudio.ai/) models.

Web search uses Bing's keyless RSS and image-search endpoints by default. Override the origin with `WEB_SEARCH_BASE_URL`; Wikipedia search uses the public MediaWiki API directly.

Tools are registered in `src/llm/tools.ts`; each registry entry supplies its schema, validation, execution, summary, and optional log compaction. The same registry generates the AI SDK tool list and the system-prompt catalog. Profile pictures may come from a current-turn web/Wikipedia image result or an uploaded Discord image.

Additional tools:

- `calculate(expression)` evaluates floating-point arithmetic with parentheses, `+`, `-`, `*`, `/`, `%` (remainder), and `^` (right-associative exponentiation), without executing code.
- `create_file(content, filename)` posts a UTF-8 attachment directly to the configured channel, up to 100,000 bytes.
- `read_attachment(message_id, attachment_id, offset?)` reads UTF-8 text/code/JSON files up to 100,000 bytes in 4,000-character pages. Use `get_message` to find attachment IDs and `next_offset` to continue. Binary documents are unsupported.
- `list_reaction_users(message_id, emoji, limit?, after?, reaction_type?)` lists normal or burst reaction users. Pass `next_after` to continue; a full final page may require an additional empty request.

Both `npm start` and `npm run dev` restart the bot when `.env` changes.

Select a local provider with `AI_PROVIDER=ollama` (default) or `AI_PROVIDER=lmstudio`; set `AI_MODEL` and, if needed, `AI_BASE_URL`. The defaults are `http://localhost:11434/v1` for Ollama and `http://localhost:1234/v1` for LM Studio. Set `AI_THINK=false` to suppress private reasoning, or any other value to enable it.

Runtime limits:

- Tool chains continue until the model returns a final response or `no_response`. Context compaction, individual request timeouts, tool argument validation, and Discord rate limits still apply.
- Fast local defaults use `qwen3.5:4b` and a 16,384-token context. Responses are not generation-capped and are split into Discord-sized chunks.
- Every request budgets for AI SDK tool schemas, output, and chat-template overhead. `CONTEXT_CHAR_LIMIT` optionally lowers the automatic input ceiling; text is counted in UTF-8 bytes. Old exchanges are removed before reference catalogs or current content are shortened. Core rules and custom instructions stay intact, and custom-instruction edits refresh on the next model call. Edits that leave insufficient request space are rejected before saving.
- Token and image costs vary by model: context overflow retries with a smaller input budget, then reports an actionable message if the core instructions and current exchange cannot fit. It does not increase the configured context or GPU allocation automatically.
- Discord tool summaries include bounded parameters, with existing prompt/memory log compaction retained. The latest human message's standalone `sudo` command overrides prompt instructions for that message; application tool validation and Discord permissions still apply.
- Member catalogs prioritize recent participants and named members (20 entries); emoji catalogs include up to 30 entries. Tools can resolve members outside the supplied catalog.
- Attachment text: three files per turn, 2,000 characters each; cache: 64 entries for ten minutes.
- Images: up to two recent PNG/JPEG/WebP uploads or Discord-proxied embed images per turn, attached to their original messages for vision. Downloads have a 4 MiB limit and five-second timeout. A 32 MiB/32-entry in-memory LRU cache shares in-flight downloads and reuses bytes across turns and tool calls; signed-URL renewal does not invalidate matching images. Eviction or restart requires downloading again. Arbitrary external URLs and redirects are not fetched.
- Image bytes are excluded from the text-character count; each image reserves an estimated 2,048 characters of context instead. Actual visual token usage depends on the model. The most recent image-bearing message is retained with the newest user message when trimming context. If images still cannot fit, their pixels are omitted with an explicit notice so the bot cannot mistake metadata for visual input.
- Busy activity: up to 50 event descriptions, with older bursts coalesced; pending messages retain the latest 100. Queues are in memory and do not survive restart.
- `MEMORY_LIMIT` defaults to 5,000. At capacity, new facts are refused; existing memories remain available for updates, consolidation, and deletion. Pre-existing indexes above the cap are preserved. Memory writes are serialized and refreshed so later writes see earlier facts.

Run one bot process per channel/index and reminder file. Deduplication and capacity checks coordinate within that process, not across multiple writers. Reminder delivery checkpoints each successful chunk using atomic file replacement; failed chunks remain pending. A crash after Discord accepts a message but before the checkpoint can still cause a duplicate on retry.

Checks: `npm run typecheck` and `node --import tsx --test tests/*.test.mjs`.
