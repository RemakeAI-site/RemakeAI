import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
export default tseslint.config(
  { ignores: ['dist/**','.wrangler/**','test-results/**','playwright-report/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { globals: { ...globals.browser,...globals.node,...globals.worker } },
    rules: { '@typescript-eslint/no-explicit-any': 'off','no-unused-vars':'off','@typescript-eslint/no-unused-vars':['warn',{argsIgnorePattern:'^_',varsIgnorePattern:'^_',caughtErrorsIgnorePattern:'^_'}], 'no-empty':['error',{allowEmptyCatch:true}] }
  },
  { files: ['**/*.ts','**/*.tsx'], rules: { 'no-undef':'off' } }
);
