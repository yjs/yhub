import nodeResolve from '@rollup/plugin-node-resolve'
import commonjs from '@rollup/plugin-commonjs'

export default [{
  input: './demo.js',
  output: {
    name: 'test',
    file: 'dist/demo.js',
    format: 'esm',
    sourcemap: true
  },
  plugins: [
    // @ts-ignore
    nodeResolve({
      mainFields: ['module', 'browser', 'main']
    }),
    // @ts-ignore
    commonjs()
  ]
}]
