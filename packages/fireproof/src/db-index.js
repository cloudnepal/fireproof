import { create, load } from 'prolly-trees/db-index'
import { sha256 as hasher } from 'multiformats/hashes/sha2'
import { nocache as cache } from 'prolly-trees/cache'
import { bf, simpleCompare } from 'prolly-trees/utils'
import * as codec from '@ipld/dag-cbor'
import { create as createBlock } from 'multiformats/block'
import { doTransaction } from './blockstore.js'
import charwise from 'charwise'

const arrayCompare = (a, b) => {
  if (Array.isArray(a) && Array.isArray(b)) {
    const len = Math.min(a.length, b.length)
    for (let i = 0; i < len; i++) {
      const comp = simpleCompare(a[i], b[i])
      if (comp !== 0) {
        return comp
      }
    }
    return simpleCompare(a.length, b.length)
  } else {
    return simpleCompare(a, b)
  }
}

const opts = { cache, chunker: bf(3), codec, hasher, compare: arrayCompare }

const ALWAYS_REBUILD = false // todo: remove this

const makeGetBlock = (blocks) => async (address) => {
  const { cid, bytes } = await blocks.get(address)
  return createBlock({ cid, bytes, hasher, codec })
}
const makeDoc = ({ key, value }) => ({ _id: key, ...value })

/**
 * JDoc for the result row type.
 * @typedef {Object} ChangeEvent
 * @property {string} key - The key of the document.
 * @property {Object} value - The new value of the document.
 * @property {boolean} [del] - Is the row deleted?
 * @memberof DbIndex
 */

/**
 * JDoc for the result row type.
 * @typedef {Object} DbIndexEntry
 * @property {string[]} key - The key for the DbIndex entry.
 * @property {Object} value - The value of the document.
 * @property {boolean} [del] - Is the row deleted?
 * @memberof DbIndex
 */

/**
 * Transforms a set of changes to DbIndex entries using a map function.
 *
 * @param {ChangeEvent[]} changes
 * @param {Function} mapFun
 * @returns {DbIndexEntry[]} The DbIndex entries generated by the map function.
 * @private
 * @memberof DbIndex
 */
const indexEntriesForChanges = (changes, mapFun) => {
  const indexEntries = []
  changes.forEach(({ key, value, del }) => {
    if (del || !value) return
    mapFun(makeDoc({ key, value }), (k, v) => {
      indexEntries.push({
        key: [charwise.encode(k), key],
        value: v
      })
    })
  })
  return indexEntries
}

const indexEntriesForOldChanges = async (blocks, byIDindexRoot, ids, mapFun) => {
  const getBlock = makeGetBlock(blocks)
  const byIDindex = await load({ cid: byIDindexRoot.cid, get: getBlock, ...opts })

  const result = await byIDindex.getMany(ids)
  return result.result
}

/**
 * Represents an DbIndex for a Fireproof database.
 *
 * @class DbIndex
 * @classdesc An DbIndex can be used to order and filter the documents in a Fireproof database.
 *
 * @param {Fireproof} database - The Fireproof database instance to DbIndex.
 * @param {Function} mapFun - The map function to apply to each entry in the database.
 *
 */
export default class DbIndex {
  constructor (database, mapFun) {
    /**
     * The database instance to DbIndex.
     * @type {Fireproof}
     */
    this.database = database
    /**
     * The map function to apply to each entry in the database.
     * @type {Function}
     */
    this.mapFun = mapFun
    this.indexRoot = null
    this.byIDindexRoot = null
    this.dbHead = null
  }

  /**
   * JSDoc for Query type.
   * @typedef {Object} DbQuery
   * @property {string[]} [range] - The range to query.
   * @memberof DbIndex
   */

  /**
   * Query object can have {range}
   * @param {DbQuery} query - the query range to use
   * @param {CID} [root] - an optional root to query a snapshot
   * @returns {Promise<{rows: Array<{id: string, key: string, value: any}>}>}
   * @memberof DbIndex
   * @instance
   */
  async query (query, root = null) {
    if (!root) {
      // pass a root to query a snapshot
      await doTransaction('#updateIndex', this.database.blocks, async (blocks) => {
        await this.#updateIndex(blocks)
      })
    }
    const response = await doIndexQuery(this.database.blocks, root || this.indexRoot, query)
    return {
      // TODO fix this naming upstream in prolly/db-DbIndex
      // todo maybe this is a hint about why deletes arent working?
      rows: response.result.map(({ id, key, row }) => ({ id: key, key: charwise.decode(id), value: row }))
    }
  }

  /**
   * Update the DbIndex with the latest changes
   * @private
   * @returns {Promise<void>}
   */
  async #updateIndex (blocks) {
    // todo remove this hack
    if (ALWAYS_REBUILD) {
      this.dbHead = null // hack
      this.indexRoot = null // hack
    }
    const result = await this.database.changesSince(this.dbHead) // {key, value, del}
    if (this.dbHead) {
      const oldIndexEntries = (
        await indexEntriesForOldChanges(
          blocks,
          this.byIDindexRoot,
          result.rows.map(({ key }) => key),
          this.mapFun
        )
      ).map((key) => ({ key, del: true })) // should be this
      this.indexRoot = await bulkIndex(blocks, this.indexRoot, oldIndexEntries, opts)
      const removeByIdIndexEntries = oldIndexEntries.map(({ key }) => ({ key: key[1], del: true }))
      this.byIDindexRoot = await bulkIndex(blocks, this.byIDindexRoot, removeByIdIndexEntries, opts)
    }
    const indexEntries = indexEntriesForChanges(result.rows, this.mapFun)
    const byIdIndexEntries = indexEntries.map(({ key }) => ({ key: key[1], value: key }))
    this.byIDindexRoot = await bulkIndex(blocks, this.byIDindexRoot, byIdIndexEntries, opts)
    // console.log('indexEntries', indexEntries)
    this.indexRoot = await bulkIndex(blocks, this.indexRoot, indexEntries, opts)
    this.dbHead = result.clock
  }

  // todo use the DbIndex from other peers?
  // we might need to add CRDT logic to it for that
  // it would only be a performance improvement, but might add a lot of complexity
  //   advanceIndex ()) {}
}

/**
 * Update the DbIndex with the given entries
 * @param {Blockstore} blocks
 * @param {Block} inRoot
 * @param {DbIndexEntry[]} indexEntries
 * @private
 */
async function bulkIndex (blocks, inRoot, indexEntries) {
  if (!indexEntries.length) return inRoot
  const putBlock = blocks.put.bind(blocks)
  const getBlock = makeGetBlock(blocks)
  if (!inRoot) {
    for await (const node of await create({ get: getBlock, list: indexEntries, ...opts })) {
      const block = await node.block
      await putBlock(block.cid, block.bytes)
      inRoot = block
    }
    return inRoot
  } else {
    const dbIndex = await load({ cid: inRoot.cid, get: getBlock, ...opts })
    const { root, blocks } = await dbIndex.bulk(indexEntries)
    const rootBlock = await root.block
    for await (const block of blocks) {
      await putBlock(block.cid, block.bytes)
    }
    await putBlock(rootBlock.cid, rootBlock.bytes)
    return rootBlock // if we hold the root we won't have to load every time
  }
}

async function doIndexQuery (blocks, root, query) {
  const cid = root && root.cid
  if (!cid) return { result: [] }
  const getBlock = makeGetBlock(blocks)
  const dbIndex = await load({ cid, get: getBlock, ...opts })
  if (query.range) {
    const encodedRange = query.range.map((key) => charwise.encode(key))
    return dbIndex.range(...encodedRange)
  } else if (query.key) {
    const encodedKey = charwise.encode(query.key)
    return dbIndex.get(encodedKey)
  }
}
