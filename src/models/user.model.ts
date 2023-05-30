import mongoose, { Schema } from 'mongoose';
import { Mate, Saved, User } from '../types/types';

const mateSchema = new Schema<Mate>({
  name: { type: String, required: true },
  img: { type: String, required: true },
});

const savedSchema = new Schema<Saved>({
  drawing: { type: String, required: true },
  img: { type: String, required: true },
});

const user_schema = new Schema({
  mate: mateSchema,
  inbox: { type: [String], required: true },
  stickers: { type: [String], required: true },
  emblems: { type: [String], required: true },
  saved: { type: [savedSchema], required: true },
  subscription: { type: String },
  name: { type: String, required: true },
  img: { type: String, required: true },
}) as mongoose.Schema<User>;

export const user_model = mongoose.model('users', user_schema);
