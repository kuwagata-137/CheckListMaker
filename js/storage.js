// storage.js — 永続化の抽象化（StorageAdapter）と、Undo/Redo を備えた中央ストア（Store）。
//
// 設計意図:
//  - StorageAdapter は「アプリ全体の状態(JSON)」を読み書きするだけの薄いIF。
//    今回は LocalStorageAdapter のみ実装。将来グループウェア等で共用したくなったら、
//    同じIFを満たす RemoteAdapter（fetch でサーバ同期）に差し替えるだけで済む。
//  - Store は状態の保持・変更・購読・Undo/Redo・自動保存を担う。
//    変更は必ず commit() を通すことでスナップショットが履歴に積まれる。

import { createInitialState } from './model.js';

const STORAGE_KEY = 'checklistmaker.v1';
const HISTORY_LIMIT = 50;

// ---- StorageAdapter 実装 ----

export class LocalStorageAdapter {
  constructor(key = STORAGE_KEY) {
    this.key = key;
  }
  load() {
    try {
      const raw = localStorage.getItem(this.key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      console.warn('状態の読み込みに失敗しました:', e);
      return null;
    }
  }
  save(state) {
    try {
      localStorage.setItem(this.key, JSON.stringify(state));
      return true;
    } catch (e) {
      console.warn('状態の保存に失敗しました:', e);
      return false;
    }
  }
}

const clone = (obj) => JSON.parse(JSON.stringify(obj));

// ---- 中央ストア ----

export class Store {
  constructor(adapter) {
    this.adapter = adapter;
    this.state = adapter.load() || createInitialState();
    // 古い保存形式に欠けたフィールドを補完
    if (!this.state.settings) this.state.settings = { theme: 'auto' };
    if (!Array.isArray(this.state.checklists)) this.state.checklists = [];

    this.undoStack = [];
    this.redoStack = [];
    this.listeners = new Set();
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  notify() {
    this.listeners.forEach((fn) => fn(this.state));
  }

  // 状態を変更する唯一の入口。
  // mutator(state) は state を直接書き換えてよい（呼ぶ前に現状をスナップショットする）。
  // history:false の場合は履歴に積まない（テーマ切替など些末な変更向け）。
  commit(mutator, { history = true } = {}) {
    if (history) {
      this.undoStack.push(clone(this.state));
      if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
      this.redoStack = [];
    }
    mutator(this.state);
    this.persist();
    this.notify();
  }

  // 履歴を残さず状態を丸ごと置き換える（インポート/共有取り込み用）。
  replaceState(newState, { history = true } = {}) {
    if (history) {
      this.undoStack.push(clone(this.state));
      this.redoStack = [];
    }
    this.state = newState;
    this.persist();
    this.notify();
  }

  canUndo() {
    return this.undoStack.length > 0;
  }
  canRedo() {
    return this.redoStack.length > 0;
  }

  undo() {
    if (!this.canUndo()) return;
    this.redoStack.push(clone(this.state));
    this.state = this.undoStack.pop();
    this.persist();
    this.notify();
  }

  redo() {
    if (!this.canRedo()) return;
    this.undoStack.push(clone(this.state));
    this.state = this.redoStack.pop();
    this.persist();
    this.notify();
  }

  persist() {
    this.adapter.save(this.state);
  }
}
