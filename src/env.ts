function required(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`missing required env var: ${name}`);
  return val;
}

export const env = {
  // hack club auth oauth
  HC_CLIENT_ID: required("HC_CLIENT_ID"),
  HC_CLIENT_SECRET: required("HC_CLIENT_SECRET"),
  HC_REDIRECT_URI: required("HC_REDIRECT_URI"), // e.g. https://yourapp.com/callback

  // gitbook
  GITBOOK_SIGNING_KEY: required("GITBOOK_SIGNING_KEY"),
  GITBOOK_DOCS_URL: required("GITBOOK_DOCS_URL"), // e.g. https://yourorg.gitbook.io/docs

  // slack
  SLACK_SIGNING_SECRET: required("SLACK_SIGNING_SECRET"),
  SLACK_BOT_TOKEN: required("SLACK_BOT_TOKEN"),

  // app
  BASE_URL: required("BASE_URL"), // e.g. https://yourapp.com
  PORT: parseInt(process.env.PORT || "3000", 10),

  // seed admin — the first admin slack ID (bootstrapping)
  SEED_ADMIN_SLACK_ID: process.env.SEED_ADMIN_SLACK_ID || "",
};
