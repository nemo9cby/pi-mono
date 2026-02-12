# @mariozechner/pi-deepresearch-agent

Minimal deep-research session wrapper on top of `@mariozechner/pi-agent-core`.

It composes an `Agent` with four MVP tools:

1. `web_search`
2. `extract_source`
3. `read`
4. `write`

The session runs iterative report updates and finalizes two artifacts:

1. `reports/<paper-slug>/report.md`
2. `reports/<paper-slug>/report.html`

## Usage

```ts
import { getModel } from "@mariozechner/pi-ai";
import { DeepResearchSession } from "@mariozechner/pi-deepresearch-agent";

const session = new DeepResearchSession({
	model: getModel("openai", "gpt-5.3"),
	maxTurns: 24,
});

const result = await session.run("https://arxiv.org/abs/1706.03762");
console.log(result.reportPath, result.reportHtmlPath, result.validation.isComplete);
```
