# Use SQLite For Bouncer State

Bitcoin Bouncer stores audit events, idempotency records, held transactions, and shadow-dropped transactions in SQLite for the MVP. This keeps the Polar sandbox simple to run while still giving the Submission Gate consistent duplicate handling, queryable Shadow Realm records, and durable operator state.
