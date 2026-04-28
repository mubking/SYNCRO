module.exports = {
  root: true,
  extends: ["next/core-web-vitals", "next/typescript"],
  parser: "@typescript-eslint/parser",
  parserOptions: {
    project: "./tsconfig.json",
    tsconfigRootDir: __dirname,
  },
  rules: {
    "@typescript-eslint/no-explicit-any": "warn",
    "@typescript-eslint/no-floating-promises": "error",
    "no-console": "warn",
    "@typescript-eslint/no-unused-vars": "warn",
  },
  overrides: [
    {
      files: ["lib/**/*.ts", "components/ui/**/*.tsx"],
      rules: {
        "@typescript-eslint/no-explicit-any": "error",
      },
    },
  ],
};
