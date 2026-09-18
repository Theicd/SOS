#!/usr/bin/env node
import { unwrapNativeDisconnect } from './gen-js-call-giftwrap-fixture.mjs';

const file = process.argv[2];
if (!file) {
  console.log('NATIVE_TO_JS_DISCONNECT=FAIL');
  process.exit(1);
}
const ok = await unwrapNativeDisconnect(file);
process.exit(ok ? 0 : 1);
