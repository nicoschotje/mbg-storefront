import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
register('./edge-stub-loader.mjs', pathToFileURL('./test/'));
