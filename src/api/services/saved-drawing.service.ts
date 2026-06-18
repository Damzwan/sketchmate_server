import { s3Creator } from '../../mongodb';
import { saved_drawing_model } from '../../models/saved-drawing.model';
import { CONTAINER } from '../../s3';


export async function getSavedDrawings(user_id: string) {
  return await saved_drawing_model.find({ user_id }).sort({ createdAt: -1 }).lean();
}

// Now it just takes the final S3 public URLs!
export async function createSaved(params: { _id: string, img: string, drawing: string }) {
  return await saved_drawing_model.create({
    user_id: params._id,
    img: params.img,
    drawing: params.drawing
  });
}

export async function deleteSaved(saved_id: string, user_id: string) {
  const target = await saved_drawing_model.findOne({ _id: saved_id, user_id });
  if (!target) throw new Error('Saved drawing not found');

  // We still want the backend to handle deletions to keep the bucket clean
  await s3Creator.deleteBlob(target.img, CONTAINER.drawings);
  await s3Creator.deleteBlob(target.drawing, CONTAINER.drawings);
  await saved_drawing_model.deleteOne({ _id: saved_id });
}