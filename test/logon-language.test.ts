import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "../src/index.js";
import { CpicTag, decodeCpicFieldChainPrefix } from "../src/protocol/cpic.js";
import {
  ScriptedRfcPeer,
  successfulRegularFields,
} from "./support/scripted-rfc-peer.js";

test("Client logon sends the selected SAP language without case folding", async (t) => {
  for (const [lang, expected, iso] of [
    ["zh", "1", "ZH"],
    ["1", "1", "ZH"],
    ["AF", "a", "AF"],
    ["a", "a", "AF"],
    ["A", "A", "AR"],
    ["d", "d", "SH"],
    ["D", "D", "DE"],
  ] as const) {
    await t.test(lang, async () => {
      let logonCount = 0;
      const peer = await ScriptedRfcPeer.start([{
        inspectInitialLogon(request) {
          const fields = decodeCpicFieldChainPrefix(
            request.subarray(18),
            CpicTag.Start,
            CpicTag.End,
          ).fields;
          const field = fields.find(({ tag }) => tag === CpicTag.Language);
          assert.ok(field);
          assert.deepEqual(field.value, Buffer.from(expected, "ascii"));
          logonCount += 1;
        },
        replies: [{ kind: "fields", fields: successfulRegularFields() }],
      }]);
      const client = new Client({
        ashost: "application.example.test",
        gwhost: "127.0.0.1",
        port: peer.port,
        client: "001",
        user: "RFCUSR",
        passwd: "synthetic-password",
        lang,
      }, { timeout: 1 });
      try {
        await client.open();
        assert.equal(client.alive, true);
        assert.equal(logonCount, 1);
        const info = client.connectionInfo;
        assert.ok(!(info instanceof Error));
        assert.equal(info.language, expected);
        assert.equal(info.isoLanguage, iso);
        assert.equal(await client.ping(), true);
        assert.equal(peer.connectionCount, 1);
      } finally {
        try {
          if (client.alive) await client.close();
        } finally {
          await peer.close();
        }
      }
    });
  }
});
