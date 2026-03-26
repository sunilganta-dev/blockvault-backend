import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const CHAIN_FILE = path.resolve('./chain.json');

class Block {
  constructor(index, timestamp, data, previousHash = '') {
    this.index = index;
    this.timestamp = timestamp;
    this.data = data;
    this.previousHash = previousHash;
    this.hash = this.calculateHash();
  }

  calculateHash() {
    return crypto
      .createHash('sha256')
      .update(this.index + this.timestamp + JSON.stringify(this.data) + this.previousHash)
      .digest('hex');
  }
}

export class Blockchain {
  constructor() {
    this.chainFile = CHAIN_FILE;
    this.chain = this.loadChain();
  }

  createGenesisBlock() {
    return new Block(0, new Date().toISOString(), { info: 'Genesis Block' }, '0');
  }

  loadChain() {
    try {
      if (fs.existsSync(this.chainFile)) {
        const raw = fs.readFileSync(this.chainFile, 'utf8');
        const parsed = JSON.parse(raw);
        return parsed;
      }
    } catch (err) {
      console.error('Error loading chain.json:', err);
    }
    const genesis = this.createGenesisBlock();
    try {
      fs.writeFileSync(this.chainFile, JSON.stringify([genesis], null, 2));
    } catch (err) {
      console.error('Error writing genesis to chain.json:', err);
    }
    return [genesis];
  }

  saveChain() {
    try {
      fs.writeFileSync(this.chainFile, JSON.stringify(this.chain, null, 2));
    } catch (err) {
      console.error('Error saving chain.json:', err);
    }
  }

  getLatestBlock() {
    return this.chain[this.chain.length - 1];
  }

  addBlock(data) {
    const latest = this.getLatestBlock();
    const index = this.chain.length;
    const timestamp = new Date().toISOString();
    const previousHash = latest.hash || latest.previousHash || '0';
    const block = new Block(index, timestamp, data, previousHash);
    const plain = {
      index: block.index,
      timestamp: block.timestamp,
      data: block.data,
      previousHash: block.previousHash,
      hash: block.hash
    };
    this.chain.push(plain);
    this.saveChain();
    return plain;
  }
}
