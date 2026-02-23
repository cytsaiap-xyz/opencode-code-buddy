---
description: "📝 Record an AI mistake for learning"
---

Use the `buddy_record_mistake` tool to record an AI mistake for learning and prevention.

The mistake details: $ARGUMENTS

Please extract:
- action: The wrong action taken
- errorType: procedure-violation, workflow-skip, assumption-error, validation-skip, etc.
- userCorrection: What the user corrected
- correctMethod: The correct approach
- impact: Impact of the mistake
- preventionMethod: How to prevent this

Then call `buddy_record_mistake` with these values.
