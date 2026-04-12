package com.example.smartgoprototype.data.local

import androidx.room.Database
import androidx.room.RoomDatabase
import com.example.smartgoprototype.data.local.dao.RouteDao
import com.example.smartgoprototype.data.local.entity.RouteEntity

@Database(
    entities = [RouteEntity::class],
    version = 3,
    exportSchema = false
)
abstract class SmartGoDatabase : RoomDatabase() {
    abstract fun routeDao(): RouteDao
}
