"use strict";

const { Client } = require("open-rfc");

const required = ["SAP_ASHOST", "SAP_CLIENT", "SAP_USER", "SAP_PASSWD"];
const missing = required.filter((name) => !process.env[name]);

async function main() {
  if (missing.length > 0) {
    console.error(
      `Missing required SAP connection environment variables: ${missing.join(", ")}`,
    );
    process.exitCode = 1;
    return;
  }

  const requestText = "hello from open-rfc";
  const client = new Client(
    {
      ashost: process.env.SAP_ASHOST,
      sysnr: process.env.SAP_SYSNR ?? "00",
      client: process.env.SAP_CLIENT,
      user: process.env.SAP_USER,
      passwd: process.env.SAP_PASSWD,
      lang: process.env.SAP_LANG ?? "EN",
    },
    { timeout: 15 },
  );

  let opened = false;
  let failure;
  try {
    await client.open();
    opened = true;
    const result = await client.call("STFC_CONNECTION", {
      REQUTEXT: requestText,
    });
    if (result.ECHOTEXT !== requestText) {
      throw new Error("STFC_CONNECTION returned an unexpected echo");
    }
  } catch (error) {
    failure = error;
  }

  if (opened) {
    try {
      await client.close();
    } catch (closeError) {
      failure = failure
        ? new AggregateError(
            [failure, closeError],
            "RFC operation and close both failed",
            { cause: failure },
          )
        : closeError;
    }
  }
  if (failure) {
    console.error("RFC operation failed; consult private, redacted diagnostics.");
    process.exitCode = 1;
  } else {
    console.log("hello from open-rfc");
  }
}

void main().catch(() => {
  console.error("RFC operation failed; consult private, redacted diagnostics.");
  process.exitCode = 1;
});
