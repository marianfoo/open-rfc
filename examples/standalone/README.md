# Standalone examples

These examples use the archived `node-rfc`-compatible `Client` surface from the
SDK-free `open-rfc` package. They call the SAP-supplied read/echo function
`STFC_CONNECTION` and print one fixed success line only after the call and
cleanup both succeed.

From a matching source tag, install the repository dependencies and build the
package once:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build
```

If you copy either file into a separate application instead, install the exact
reviewed `open-rfc` release in that application first. Then provide connection
values through the environment:

```sh
export SAP_ASHOST=app.example.invalid
export SAP_SYSNR=00
export SAP_CLIENT=001
export SAP_USER='your-rfc-user'
read -rsp 'SAP password: ' SAP_PASSWD
printf '\n'
export SAP_PASSWD
node examples/standalone/hello-world.mjs
# Or, from the same shell, run the CommonJS version:
node examples/standalone/hello-world.cjs
unset SAP_PASSWD
```

If any required variable is absent, the process exits non-zero and lists only
the missing variable names. On success it prints the fixed line
`hello from open-rfc`; it does not print connection details or arbitrary SAP
response data.

The password prompt above requires Bash. In unattended environments, inject
`SAP_PASSWD` through the platform's secret manager instead. Do not put
credentials in source, shell history, logs, traces, or bug reports.
Each example always closes the client. If the call and close both fail, it
preserves both errors and keeps the call failure as the primary cause
internally, then emits only a fixed failure line. A timeout, cancellation,
protocol error, or transport error is not automatically replayed. Production
code may route the retained error only to an application-owned private handler
with an explicit redaction policy.
RFM parameter keys use the exact casing declared by SAP metadata; the example
therefore passes `REQUTEXT`, not `requtext`.

An existing application may install the same reviewed artifact under the
`node-rfc` module ID with an npm alias or local tarball. Unchanged
`@sap/cds-rfc` applications can use npm 11's nested override to resolve their
low-level `@sap-rfc/node-rfc-library` dependency to this artifact. Neither
SAP-controlled npm scope is owned by this project.
