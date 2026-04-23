#!/usr/bin/env python3
"""Collection API routes."""

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from src.backend.database import get_session
from src.backend.models import Collection, Job, Project

router = APIRouter()


class CollectionCreate(BaseModel):
    project_id: int
    job_id: Optional[int] = None
    name: str
    description: Optional[str] = None
    schema_definition: Dict = {}


class CollectionUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None


@router.get("/", response_model=List[Dict[str, Any]])
async def list_collections(project_id: Optional[int] = None):
    async with get_session() as session:
        query = session.query(Collection)
        if project_id:
            query = query.filter(Collection.project_id == project_id)
        collections = await session.execute(query.order_by(Collection.created_at.desc()))
        return [c.to_dict() for c in collections.scalars().all()]


@router.get("/{collection_id}", response_model=Dict[str, Any])
async def get_collection(collection_id: int):
    async with get_session() as session:
        collection = await session.get(Collection, collection_id)
        if not collection:
            raise HTTPException(status_code=404, detail="Collection not found")
        return collection.to_dict()


@router.post("/", response_model=Dict[str, Any])
async def create_collection(collection_data: CollectionCreate):
    async with get_session() as session:
        project = await session.get(Project, collection_data.project_id)
        if not project:
            raise HTTPException(status_code=404, detail="Project not found")

        collection = Collection(
            project_id=collection_data.project_id,
            job_id=collection_data.job_id,
            name=collection_data.name,
            description=collection_data.description,
            schema_definition=str(collection_data.schema_definition),
            data="[]",
        )
        session.add(collection)
        await session.commit()
        await session.refresh(collection)
        return collection.to_dict()


@router.patch("/{collection_id}", response_model=Dict[str, Any])
async def update_collection(collection_id: int, collection_data: CollectionUpdate):
    async with get_session() as session:
        collection = await session.get(Collection, collection_id)
        if not collection:
            raise HTTPException(status_code=404, detail="Collection not found")

        update_data = collection_data.model_dump(exclude_unset=True)
        for field, value in update_data.items():
            setattr(collection, field, value)

        await session.commit()
        await session.refresh(collection)
        return collection.to_dict()


@router.delete("/{collection_id}")
async def delete_collection(collection_id: int):
    async with get_session() as session:
        collection = await session.get(Collection, collection_id)
        if not collection:
            raise HTTPException(status_code=404, detail="Collection not found")

        await session.delete(collection)
        await session.commit()
        return {"deleted": True}


@router.post("/{collection_id}/export/jsonl")
async def export_to_jsonl(collection_id: int):
    async with get_session() as session:
        collection = await session.get(Collection, collection_id)
        if not collection:
            raise HTTPException(status_code=404, detail="Collection not found")

        import json

        content = "\n".join(json.dumps(item) for item in eval(collection.data))

    from fastapi.responses import Response

    return Response(
        content=content,
        media_type="application/jsonl",
        headers={
            "Content-Disposition": f"attachment; filename={collection.name}.jsonl"
        },
    )


@router.post("/{collection_id}/export/csv")
async def export_to_csv(collection_id: int):
    async with get_session() as session:
        collection = await session.get(Collection, collection_id)
        if not collection:
            raise HTTPException(status_code=404, detail="Collection not found")

        import csv
        import io

        output = io.StringIO()
        data = eval(collection.data)
        if data:
            writer = csv.DictWriter(
                output, fieldnames=eval(collection.schema_definition).get("properties", {}).keys()
            )
            writer.writeheader()
            for item in data:
                writer.writerow(item)

    from fastapi.responses import Response

    return Response(
        content=output.getvalue(),
        media_type="text/csv",
        headers={
            "Content-Disposition": f"attachment; filename={collection.name}.csv"
        },
    )


@router.post("/{collection_id}/items")
async def add_items(collection_id: int, items: List[Dict[str, Any]]):
    async with get_session() as session:
        collection = await session.get(Collection, collection_id)
        if not collection:
            raise HTTPException(status_code=404, detail="Collection not found")

        current_data = eval(collection.data) if collection.data else []
        for item in items:
            current_data.append(item)

        collection.data = str(current_data)
        collection.total_items += len(items)
        await session.commit()
        return {"added": len(items)}


@router.delete("/{collection_id}/items/{item_index}")
async def delete_item(collection_id: int, item_index: int):
    async with get_session() as session:
        collection = await session.get(Collection, collection_id)
        if not collection:
            raise HTTPException(status_code=404, detail="Collection not found")

        data = eval(collection.data) if collection.data else []
        if item_index < len(data):
            data.pop(item_index)
            collection.data = str(data)
            collection.total_items -= 1
            await session.commit()
            return {"deleted": True}
        raise HTTPException(status_code=404, detail="Item not found")


@router.get("/{collection_id}/items", response_model=Dict[str, Any])
async def list_items(
    collection_id: int,
    page: int = 1,
    limit: int = 50,
    search: Optional[str] = None,
):
    async with get_session() as session:
        collection = await session.get(Collection, collection_id)
        if not collection:
            raise HTTPException(status_code=404, detail="Collection not found")

        data = eval(collection.data) if collection.data else []

        if search:
            import json

            search_lower = search.lower()
            data = [item for item in data if search_lower in json.dumps(item).lower()]

        total_items = len(data)
        start_index = (page - 1) * limit
        end_index = start_index + limit
        paginated_data = data[start_index:end_index]

        return {
            "data": paginated_data,
            "total_items": total_items,
            "current_page": page,
            "items_per_page": limit,
            "total_pages": (total_items + limit - 1) // limit if limit > 0 else 1,
        }
