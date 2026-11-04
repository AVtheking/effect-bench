import { Bench } from '@avtheking/bench'
import { Effect, Schema } from 'effect'

const Lead = Schema.Struct({
  email: Schema.String,
  name: Schema.String,
  score: Schema.Number,
  tags: Schema.Array(Schema.String),
})

const lead = { email: 'ada@example.com', name: 'Ada', score: 42, tags: ['b2b', 'saas'] }
const decodeEffect = Schema.decodeUnknownEffect(Lead)
const decodeSync = Schema.decodeUnknownSync(Lead)

export default Bench.suite('leadSchema')(
  Bench.group('decode', { baseline: 'sync' })(
    Bench.sync('sync', () => decodeSync(lead)),
    Bench.make('effect', () => decodeEffect(lead))
  ),
  Bench.params(
    'stringify',
    { rows: [10, 1000] },
    {
      prepare: ({ rows }) => Effect.succeed(Array.from({ length: rows }, () => lead)),
      sync: leads => JSON.stringify(leads),
      budget: { p99: '5 millis' },
    }
  )
)
