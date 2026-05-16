# Separate Live Decisions From Background Analysis

Bitcoin Bouncer uses a bounded Live Agent for per-transaction decisions and a separate Background Analyst for burst-level review, prompt tuning, and policy reflection. This keeps the live transaction path fast and fail-open while still allowing powerful inference to improve judgment outside the critical path.
