# Bitcoin Bouncer Demo

Read-only smoke-test dashboard for the Bitcoin Bouncer MVP.

## Run

Start the Bouncer Runtime on `127.0.0.1:3130`, then run:

```sh
npm install
npm run dev
```

The Vite dev server proxies `/v1/*` requests to `http://127.0.0.1:3130` so the browser does not need CORS changes in the Fastify API.

To point at a different API origin, set:

```sh
VITE_BOUNCER_API_URL=http://127.0.0.1:3130 npm run dev
```

## Surface

The dashboard uses live API data only:

- `/v1/health`
- `/v1/audit`
- `/v1/holds`
- `/v1/demo/events`

It presents the current smoke-test path as three actors:

- **Bouncer Test Sender**
- **Bouncer Runtime**
- **Propagation Witness**

Existing smoke and fuzz scripts publish live run progress to `/v1/demo/events`.
