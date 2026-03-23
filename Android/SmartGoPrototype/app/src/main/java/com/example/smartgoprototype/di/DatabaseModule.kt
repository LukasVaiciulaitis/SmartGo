package com.example.smartgoprototype.di

import android.content.Context
import androidx.room.Room
import com.example.smartgoprototype.data.local.SmartGoDatabase
import com.example.smartgoprototype.data.local.dao.RouteDao
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

@Module
@InstallIn(SingletonComponent::class)
object DatabaseModule {

    @Provides
    @Singleton
    fun provideDatabase(@ApplicationContext context: Context): SmartGoDatabase =
        Room.databaseBuilder(context, SmartGoDatabase::class.java, "smartgo.db")
            .fallbackToDestructiveMigration(dropAllTables = true)
            .build()

    @Provides
    @Singleton
    fun provideRouteDao(db: SmartGoDatabase): RouteDao = db.routeDao()
}
