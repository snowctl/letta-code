// src/channels/matrix/turn/ChatTurnRegistry.ts
import type { ChatTurn } from "./ChatTurn";

export class ChatTurnRegistry {
  private turns = new Map<string, ChatTurn>();

  constructor(private factory: (chatId: string) => ChatTurn) {}

  getOrCreate(chatId: string): ChatTurn {
    let turn = this.turns.get(chatId);
    if (!turn) {
      turn = this.factory(chatId);
      this.turns.set(chatId, turn);
    }
    return turn;
  }

  get(chatId: string): ChatTurn | undefined {
    return this.turns.get(chatId);
  }

  delete(chatId: string): void {
    this.turns.delete(chatId);
  }

  disposeAll(): void {
    for (const turn of this.turns.values()) {
      turn.dispose();
    }
    this.turns.clear();
  }
}
