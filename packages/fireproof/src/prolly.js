import {
  advance,
  EventFetcher,
  EventBlock,
  findCommonAncestorWithSortedEvents,
  findUnknownSortedEvents
} from './clock.js'
import { create, load } from 'prolly-trees/map'
import * as codec from '@ipld/dag-cbor'
import { sha256 as hasher } from 'multiformats/hashes/sha2'
import { MemoryBlockstore, MultiBlockFetcher } from './block.js'
import { doTransaction } from './blockstore.js'

import { nocache as cache } from 'prolly-trees/cache'
import { bf, simpleCompare as compare } from 'prolly-trees/utils'
import { create as createBlock } from 'multiformats/block'
const opts = { cache, chunker: bf(3), codec, hasher, compare }

const withLog = async (label, fn) => {
  const resp = await fn()
  // console.log('withLog', label, !!resp)
  return resp
}

const makeGetBlock = (blocks) => async (address) => {
  const { cid, bytes } = await withLog(address, () => blocks.get(address))
  return createBlock({ cid, bytes, hasher, codec })
}

/**
 * Creates and saves a new event.
 * @param {import('./blockstore.js').Blockstore} inBlocks - A persistent blockstore.
 * @param {MemoryBlockstore} mblocks - A temporary blockstore.
 * @param {Function} getBlock - A function that gets a block.
 * @param {Function} bigPut - A function that puts a block.
 * @param {import('prolly-trees/map').Root} root - The root node.
 * @param {Object<{ key: string, value: any, del: boolean }>} event - The update event.
 * @param {CID[]} head - The head of the event chain.
 * @param {Array<import('multiformats/block').Block>} additions - A array of additions.
 * @param {Array<mport('multiformats/block').Block>>} removals - An array of removals.
 * @returns {Promise<{
 *   root: import('prolly-trees/map').Root,
 *   additions: Map<string, import('multiformats/block').Block>,
 *   removals: Array<string>,
 *   head: CID[],
 *   event: CID[]
 * }>}
 */
async function createAndSaveNewEvent (
  inBlocks,
  mblocks,
  getBlock,
  bigPut,
  root,
  { key, value, del },
  head,
  additions,
  removals = []
) {
  const data = {
    type: 'put',
    root: {
      cid: root.cid,
      bytes: root.bytes,
      value: root.value
    },
    key
  }

  if (del) {
    data.value = null
    data.type = 'del'
  } else {
    data.value = value
  }
  /** @type {EventData} */

  const event = await EventBlock.create(data, head)
  bigPut(event)
  head = await advance(inBlocks, head, event.cid)

  return {
    root,
    additions,
    removals,
    head,
    event
  }
}

const makeGetAndPutBlock = (inBlocks) => {
  const mblocks = new MemoryBlockstore()
  const blocks = new MultiBlockFetcher(mblocks, inBlocks)
  const getBlock = makeGetBlock(blocks)
  const put = inBlocks.put.bind(inBlocks)
  const bigPut = async (block, additions) => {
    // console.log('bigPut', block.cid.toString())
    const { cid, bytes } = block
    put(cid, bytes)
    mblocks.putSync(cid, bytes)
    if (additions) {
      additions.set(cid.toString(), block)
    }
  }
  return { getBlock, bigPut, mblocks, blocks }
}

const bulkFromEvents = (sorted) =>
  sorted.map(({ value: event }) => {
    const {
      data: { type, value, key }
    } = event
    return type === 'put' ? { key, value } : { key, del: true }
  })

// Get the value of the root from the ancestor event
/**
 *
 * @param {EventFetcher} events
 * @param {Link} ancestor
 * @param {*} getBlock
 * @returns
 */
const prollyRootFromAncestor = async (events, ancestor, getBlock) => {
  // console.log('prollyRootFromAncestor', ancestor)
  const event = await events.get(ancestor)
  const { root } = event.value.data
  // console.log('prollyRootFromAncestor', root.cid, JSON.stringify(root.value))
  return load({ cid: root.cid, get: getBlock, ...opts })
}

/**
 * Put a value (a CID) for the given key. If the key exists it's value is overwritten.
 *
 * @param {import('./block').BlockFetcher} blocks Bucket block storage.
 * @param {import('./clock').EventLink<EventData>[]} head Merkle clock head.
 * @param {string} key The key of the value to put.
 * @param {CID} value The value to put.
 * @param {object} [options]
 * @returns {Promise<Result>}
 */
export async function put (inBlocks, head, event, options) {
  const { getBlock, bigPut, mblocks, blocks } = makeGetAndPutBlock(inBlocks)

  // If the head is empty, we create a new event and return the root and addition blocks
  if (!head.length) {
    const additions = new Map()
    let root
    for await (const node of create({ get: getBlock, list: [event], ...opts })) {
      root = await node.block
      bigPut(root, additions)
    }
    return createAndSaveNewEvent(inBlocks, mblocks, getBlock, bigPut, root, event, head, Array.from(additions.values()))
  }

  // Otherwise, we find the common ancestor and update the root and other blocks
  const events = new EventFetcher(blocks)
  const { ancestor, sorted } = await findCommonAncestorWithSortedEvents(events, head)
  const prollyRootNode = await prollyRootFromAncestor(events, ancestor, getBlock)

  const bulkOperations = bulkFromEvents(sorted)
  const { root: newProllyRootNode, blocks: newBlocks } = await prollyRootNode.bulk([...bulkOperations, event]) // ading delete support here
  const prollyRootBlock = await newProllyRootNode.block
  const additions = new Map() // ; const removals = new Map()
  bigPut(prollyRootBlock, additions)
  for (const nb of newBlocks) {
    bigPut(nb, additions)
  }

  return createAndSaveNewEvent(
    inBlocks,
    mblocks,
    getBlock,
    bigPut,
    prollyRootBlock,
    event,
    head,
    Array.from(additions.values()) /*, Array.from(removals.values()) */
  )
}

/**
 * Determine the effective prolly root given the current merkle clock head.
 *
 * @param {import('./block').BlockFetcher} blocks Bucket block storage.
 * @param {import('./clock').EventLink<EventData>[]} head Merkle clock head.
 */
export async function root (inBlocks, head) {
  if (!head.length) {
    throw new Error('no head')
  }
  const { getBlock, blocks } = makeGetAndPutBlock(inBlocks)
  const events = new EventFetcher(blocks)
  const { ancestor, sorted } = await findCommonAncestorWithSortedEvents(events, head)
  const prollyRootNode = await prollyRootFromAncestor(events, ancestor, getBlock)

  // Perform bulk operations (put or delete) for each event in the sorted array
  const bulkOperations = bulkFromEvents(sorted)
  const { root: newProllyRootNode, blocks: newBlocks } = await prollyRootNode.bulk(bulkOperations)
  const prollyRootBlock = await newProllyRootNode.block
  // console.log('emphemeral blocks', newBlocks.map((nb) => nb.cid.toString()))
  // todo maybe these should go to a temp blockstore?
  await doTransaction('root', inBlocks, async (transactionBlockstore) => {
    const { bigPut } = makeGetAndPutBlock(transactionBlockstore)
    for (const nb of newBlocks) {
      bigPut(nb)
    }
    bigPut(prollyRootBlock)
  })

  return newProllyRootNode // .block).cid // todo return live object not cid
}

/**
 * Get the list of events not known by the `since` event
 * @param {import('./block').BlockFetcher} blocks Bucket block storage.
 * @param {import('./clock').EventLink<EventData>[]} head Merkle clock head.
 * @param {import('./clock').EventLink<EventData>} since Event to compare against.
 * @returns {Promise<import('./clock').EventLink<EventData>[]>}
 */
export async function eventsSince (blocks, head, since) {
  if (!head.length) {
    throw new Error('no head')
  }
  const sinceHead = [...since, ...head]
  const unknownSorted3 = await findUnknownSortedEvents(
    blocks,
    sinceHead,
    await findCommonAncestorWithSortedEvents(blocks, sinceHead)
  )
  return unknownSorted3.map(({ value: { data } }) => data)
}

/**
 *
 * @param {import('./block').BlockFetcher} blocks Bucket block storage.
 * @param {import('./clock').EventLink<EventData>[]} head Merkle clock head.
 *
 * @returns {Promise<import('./prolly').Entry[]>}
 *
 */
export async function getAll (blocks, head) {
  // todo use the root node left around from put, etc
  // move load to a central place
  if (!head.length) {
    return []
  }
  const prollyRootNode = await root(blocks, head)
  const { result } = await prollyRootNode.getAllEntries()
  return result.map(({ key, value }) => ({ key, value }))
}

/**
 * @param {import('./block').BlockFetcher} blocks Bucket block storage.
 * @param {import('./clock').EventLink<EventData>[]} head Merkle clock head.
 * @param {string} key The key of the value to retrieve.
 */
export async function get (blocks, head, key) {
  // instead pass root from db? and always update on change
  if (!head.length) {
    return null
  }
  const prollyRootNode = await root(blocks, head)
  const { result } = await prollyRootNode.get(key)
  return result
}
