import { BenchConfig } from '@effect-bench/cli'

export default BenchConfig.make({
  profiles: {
    small: { cpus: 1, memory: '512 MiB' },
    large: { cpus: 4, memory: '2 GiB' },
  },
})
