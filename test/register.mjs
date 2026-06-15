import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
register('./stub-loader.mjs', pathToFileURL('./test/'));
